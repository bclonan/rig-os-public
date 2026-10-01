import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Store } from "../src/storage/index.js";
import { DesktopRouter } from "../src/adapters/desktop.js";
import { Runtime } from "../src/runtime/index.js";
import { LocalDesktopPlanner } from "../src/assistant/local.js";
import { service } from "../src/service/index.js";

const store = new Store(mkdtempSync(join(tmpdir(), "cur-desktop-console-")));
const adapter = new DesktopRouter(store);
const runtime = new Runtime(
  store,
  adapter,
  undefined,
  undefined,
  undefined,
  new LocalDesktopPlanner(store),
);
const app = await service(runtime);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
const report: any = {
  at: new Date().toISOString(),
  status: "NOT RUN",
  evidenceLevel:
    "live Vue console, actual Notepad window, local Qwen 3.6, native GUI input",
  actions: [],
  checks: [],
};
try {
  await adapter.start();
  const windows = await adapter.windows();
  const candidates = windows.windows.filter(
    (w: any) => w.title === "Untitled - Notepad",
  );
  assert.equal(
    candidates.length,
    1,
    "Open exactly one empty Notepad window for this test",
  );
  const target = candidates[0];
  const before = await adapter.native!.client.call("accessibility", {
    handle: target.handle,
  });
  assert.ok(
    before.some((c: any) => [50004, 50030].includes(c.controlType) && !c.value),
    "Use an empty document",
  );
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  await page.goto(url);
  await page
    .getByLabel("Local service token", { exact: true })
    .fill(store.token());
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("heading", { name: "New desktop task" }).waitFor();
  await page.getByLabel("One window", { exact: true }).check();
  await page
    .getByLabel("Open app", { exact: true })
    .selectOption(String(target.handle));
  const content = "Desktop assistant test. Meeting at 10 AM.";
  await page
    .getByLabel("What should the assistant do?")
    .fill(
      `Write exactly "${content}" in this empty Notepad document. Do not save it. Stop when that exact text is visible.`,
    );
  await page
    .getByLabel("Local model", { exact: true })
    .selectOption("qwen3.6:latest");
  await page
    .getByRole("button", { name: "Plan desktop task", exact: true })
    .click();
  for (let attempt = 0; attempt < 10; attempt++) {
    const until = Date.now() + 180000;
    let run: any;
    while (Date.now() < until) {
      run = store.runs().find((r) => r.contract.method === "desktop.assistant");
      if (run && !["running", "queued"].includes(run.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(run, "A desktop task was submitted");
    report.runId = run.id;
    console.log(
      JSON.stringify({
        status: run.status,
        message: run.bindings.assistantMessage,
        error: run.error,
      }),
    );
    if (run.status !== "awaiting_approval") {
      report.finalStatus = run.status;
      break;
    }
    const p: any = run.bindings.proposal;
    const c = p.observation.controls.find(
      (c: any) => c.index === p.decision.control,
    );
    // This test can approve only a document focus and the exact disposable text.
    if (p.decision.operation === "click")
      assert.ok(c && [50004, 50030].includes(c.controlType));
    else if (["fill", "type"].includes(p.decision.operation))
      assert.equal(p.decision.text, content);
    else
      throw new Error(
        "Unexpected action in the disposable typing test: " +
          JSON.stringify(p.decision),
      );
    report.actions.push(p.decision);
    await page
      .getByRole("button", { name: "Approve this action", exact: true })
      .waitFor();
    await page
      .getByRole("button", { name: "Approve this action", exact: true })
      .click();
    // Wait until the POST has left awaiting_approval before polling the next decision.
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll("button")).some(
          (b) => b.textContent?.trim() === "Approve this action",
        ),
    );
  }
  const controls = await adapter.native!.client.call("accessibility", {
    handle: target.handle,
  });
  const text = controls
    .filter((c: any) => [50004, 50030].includes(c.controlType))
    .map((c: any) => c.value.trim());
  assert.ok(
    text.includes(content),
    "Independent UIA document read matches the requested text",
  );
  assert.equal(report.finalStatus, "needs_review");
  await page
    .getByRole("button", { name: "Confirm task complete", exact: true })
    .waitFor();
  const screenshot = page.getByRole("img", {
    name: "Selected app at the latest desktop observation",
  });
  await screenshot.waitFor();
  assert.ok(await screenshot.evaluate((img: any) => img.naturalWidth > 0));
  await page.screenshot({
    path: "evidence/desktop-console.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Confirm task complete", exact: true })
    .click();
  await page.waitForTimeout(500);
  assert.equal(store.run(report.runId).status, "completed_by_user");
  report.checks = [
    "window picker",
    "task submission",
    "per-action approval",
    "visible PNG preview",
    "independent exact Notepad text",
    "human confirmation distinct from verification",
  ];
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  report.checks.push("390px responsive layout", "no browser exceptions");
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  writeFileSync(
    "evidence/desktop-console.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  await app.close();
  console.log(JSON.stringify(report, null, 2));
}
