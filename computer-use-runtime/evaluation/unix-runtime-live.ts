import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/storage/index.js";
import { DesktopRouter } from "../src/adapters/desktop.js";
import { Runtime } from "../src/runtime/index.js";
import { service } from "../src/service/index.js";
import type { DesktopPlanner } from "../src/assistant/planner.js";
import { chromium } from "playwright";

const store = new Store(mkdtempSync(join(tmpdir(), "cur-unix-runtime-")));
const adapter = new DesktopRouter(store);
const content = "Cross-platform runtime verified ✓";
let stage = 0;
const planner: DesktopPlanner = {
  async next(_task, observation) {
    const step = stage++;
    if (step === 0) {
      const app = observation.desktop!.apps.find((a) => a.id === "calculator");
      assert.ok(
        app,
        "Install galculator in the disposable Linux test environment",
      );
      return {
        kind: "action",
        summary: "Launch the disposable calculator",
        operation: "launch_app",
        app: app.id,
      };
    }
    if (step === 1) {
      const window = observation.desktop!.windows.find(
        (w) => w.title === "Computer runtime disposable editor",
      );
      assert.ok(window);
      return {
        kind: "action",
        summary: "Select the disposable editor",
        operation: "switch_window",
        window: window.id,
      };
    }
    const editor = observation.controls?.find((c) => c.name === "Test text");
    assert.ok(editor);
    if (editor.value !== content)
      return {
        kind: "action",
        summary: "Write the disposable text",
        operation: "fill",
        control: editor.index,
        text: content,
      };
    return { kind: "done", summary: "The disposable text is present" };
  },
};
const runtime = new Runtime(
  store,
  adapter,
  undefined,
  undefined,
  undefined,
  planner,
);
const app = await service(runtime);
const report: any = {
  at: new Date().toISOString(),
  status: "NOT RUN",
  platform: process.platform,
  node: process.version,
  evidenceLevel:
    "real Linux adapter and GTK app through shared HTTP/runtime/Vue; scripted planner, no model quality claim",
  checks: [],
};
async function api(url: string, body?: unknown) {
  const r = await app.inject({
    method: body ? "POST" : "GET",
    url,
    headers: {
      host: "127.0.0.1",
      authorization: "Bearer " + store.token(),
      "idempotency-key": randomUUID(),
      "x-correlation-id": randomUUID(),
    },
    ...(body ? { payload: body } : {}),
  });
  assert.ok(r.statusCode < 400, r.body);
  return r.json();
}
let browser;
try {
  await adapter.start();
  const desktop = await api("/api/desktop/windows");
  assert.equal(desktop.available, true);
  assert.equal(desktop.system.name, "Linux");
  assert.ok(desktop.operations.includes("fill"));
  const run = await api("/api/desktop/tasks", {
    scope: "computer",
    goal: "Write the test phrase in the disposable GTK editor",
    model: "scripted-native-check",
  });
  for (let step = 0; step < 5; step++) {
    await runtime.execute(run.id);
    const state = store.run(run.id);
    if (state.status !== "awaiting_approval") {
      assert.equal(
        state.status,
        "needs_review",
        state.error || "Expected review state",
      );
      break;
    }
    const proposal = state.bindings.proposal as any;
    assert.ok(
      ["launch_app", "switch_window", "fill"].includes(
        proposal.decision.operation,
      ),
    );
    await api(`/api/desktop/tasks/${run.id}/review`, {
      command: "approve",
      proposalId: proposal.id,
    });
  }
  assert.equal(store.run(run.id).status, "needs_review");
  const observed = await adapter.observe();
  assert.ok(
    observed.controls?.some(
      (c) => c.name === "Test text" && c.value === content,
    ),
  );
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url);
  await page
    .getByLabel("Local service token", { exact: true })
    .fill(store.token());
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByText("Computer control ready", { exact: false }).waitFor();
  await page
    .getByRole("button", { name: "Confirm task complete", exact: true })
    .waitFor();
  if (observed.image) {
    const img = page.getByRole("img", {
      name: "Selected app at the latest desktop observation",
    });
    await img.waitFor();
    await page.waitForFunction(() =>
      [...document.images].some((i) => i.naturalWidth > 0),
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  report.status = "PASS";
  report.backend = observed.backend;
  report.checks = [
    "automatic Linux adapter selection",
    "capability discovery",
    "computer task HTTP submission",
    "per-action review",
    "fixed app launch",
    "cross-app switch",
    "native Unicode edit",
    "independent accessibility result",
    "live console on Linux",
    "390px layout",
    "no browser exceptions",
  ];
} catch (e) {
  report.status = "FAIL";
  report.error = String(e);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app.close();
  writeFileSync(
    process.env.XDG_SESSION_TYPE === "wayland"
      ? "evidence/linux-wayland-runtime.json"
      : "evidence/linux-runtime.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
