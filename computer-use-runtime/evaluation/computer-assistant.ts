import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { chromium } from "playwright";
import { Store } from "../src/storage/index.js";
import { DesktopRouter } from "../src/adapters/desktop.js";
import { Runtime } from "../src/runtime/index.js";
import { LocalDesktopPlanner } from "../src/assistant/local.js";
import { service } from "../src/service/index.js";

const store = new Store(mkdtempSync(join(tmpdir(), "cur-computer-live-")));
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
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(String(e)));
const report: any = {
  at: new Date().toISOString(),
  status: "NOT RUN",
  evidenceLevel:
    "live Vue console, local Qwen 3.6, actual Windows app launch and cross-app input",
  model: "qwen3.6:latest",
  actions: [],
  checks: [],
  store: store.root,
};
try {
  await adapter.start();
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  await page.goto(url);
  await page
    .getByLabel("Local service token", { exact: true })
    .fill(store.token());
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("heading", { name: "New desktop task" }).waitFor();
  assert.ok(
    await page.getByLabel("This computer", { exact: true }).isChecked(),
  );
  await page.getByLabel("One window", { exact: true }).check();
  await page.getByLabel("Open app", { exact: true }).waitFor();
  await page.getByLabel("This computer", { exact: true }).check();
  assert.equal(await page.getByLabel("Open app", { exact: true }).count(), 0);
  await page
    .getByLabel("What should the assistant do?")
    .fill(
      'Open Calculator. Clear any previous calculation, then calculate 23 times 17 using its buttons. Next open Notepad, create a NEW document using Control+N, and write exactly "23 x 17 = <the result from Calculator>" replacing the angle-bracket placeholder with the displayed result. Leave all existing documents untouched. Do not save or close any document. Finish in Notepad.',
    );
  await page
    .getByLabel("Local model", { exact: true })
    .selectOption(report.model);
  await page
    .getByRole("button", { name: "Plan desktop task", exact: true })
    .click();
  let newDocument = false;
  for (let attempt = 0; attempt < 26; attempt++) {
    const until = Date.now() + 180000;
    let run: any;
    while (Date.now() < until) {
      run = store.runs()[0];
      if (run && !["running", "queued"].includes(run.status)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(run, "Task submitted");
    report.runId = run.id;
    console.log(
      JSON.stringify({
        status: run.status,
        cursor: run.cursor,
        message: run.bindings.assistantMessage,
        error: run.error,
      }),
    );
    if (run.status !== "awaiting_approval") {
      report.finalStatus = run.status;
      break;
    }
    const p = run.bindings.proposal;
    const d = p.decision;
    const current = p.observation.desktop?.windows.find(
      (w: any) => w.id === p.observation.desktop.activeWindow,
    );
    const exe = basename(current?.executable || "").toLowerCase();
    const control = p.observation.controls?.find(
      (c: any) => c.index === d.control,
    );
    if (d.operation === "launch_app")
      assert.ok(["calculator", "notepad"].includes(d.app));
    else if (d.operation === "switch_window") {
      const target = p.observation.desktop.windows.find(
        (w: any) => w.id === d.window,
      );
      assert.ok(
        ["calculatorapp.exe", "calc.exe", "notepad.exe"].includes(
          basename(target.executable).toLowerCase(),
        ),
      );
    } else if (["calculatorapp.exe", "calc.exe"].includes(exe)) {
      assert.ok(["invoke", "click"].includes(d.operation));
      assert.match(
        control?.id || "",
        /^(num\dButton|clearButton|clearEntryButton|multiplyButton|equalButton)$/,
      );
    } else if (exe === "notepad.exe") {
      if (d.operation === "key") {
        assert.equal(d.key, "Control+N");
        newDocument = true;
      } else {
        assert.ok(newDocument, "Create a fresh document before editing");
        if (d.operation === "click")
          assert.ok(control && [50004, 50030].includes(control.controlType));
        else {
          assert.ok(["fill", "type"].includes(d.operation));
          assert.equal(d.text, "23 x 17 = 391");
          assert.ok(
            p.observation.controls.some(
              (c: any) =>
                [50004, 50030].includes(c.controlType) && c.value.trim() === "",
            ),
            "Only edit an empty new document",
          );
        }
      }
    } else throw new Error("Test will not approve input to another app");
    report.actions.push({
      decision: d,
      app: exe || "computer",
      control: control?.id,
    });
    // Let the console's refresh show this proposal before pressing its review button.
    await page.getByText(d.summary, { exact: true }).waitFor();
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/desktop/tasks/${run.id}/review`) &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Approve this action", exact: true })
      .click();
    assert.ok((await response).ok());
    await runtime.execute(run.id);
  }
  assert.equal(report.finalStatus, "needs_review");
  const observed = await adapter.observe();
  assert.ok(
    observed.controls?.some(
      (c) =>
        [50004, 50030].includes(c.controlType) &&
        c.value.trim() === "23 x 17 = 391",
    ),
  );
  const windows = await adapter.windows();
  const calculator = windows.windows.find(
    (w: any) => basename(w.executable).toLowerCase() === "calculatorapp.exe",
  );
  assert.ok(calculator);
  const calc = await adapter.native!.client.call("accessibility", {
    handle: calculator.handle,
  });
  assert.ok(
    calc.some(
      (c: any) => c.id === "CalculatorResults" && c.name === "Display is 391",
    ),
  );
  assert.ok(
    report.actions.some((a: any) => a.decision.operation === "launch_app"),
  );
  await page
    .getByRole("button", { name: "Confirm task complete", exact: true })
    .waitFor();
  const confirmation = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/api/desktop/tasks/${report.runId}/review`) &&
      r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Confirm task complete", exact: true })
    .click();
  await confirmation;
  assert.equal(store.run(report.runId).status, "completed_by_user");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  report.checks = [
    "scope picker",
    "computer task without an initial window",
    "reviewed app launch/navigation",
    "independent Calculator result 391",
    "independent new Notepad document text",
    "no existing document edits approved",
    "human confirmation",
    "390px layout",
    "no browser exceptions",
  ];
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  writeFileSync(
    "evidence/computer-assistant.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  await app.close();
  console.log(JSON.stringify(report, null, 2));
}
