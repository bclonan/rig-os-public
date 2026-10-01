import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store } from "../src/storage/index.js";
import { DesktopRouter } from "../src/adapters/desktop.js";
import { Runtime } from "../src/runtime/index.js";
import { LocalDesktopPlanner } from "../src/assistant/local.js";
const store = new Store(mkdtempSync(join(tmpdir(), "cur-desktop-vision-")));
const adapter = new DesktopRouter(store);
const runtime = new Runtime(
  store,
  adapter,
  undefined,
  undefined,
  undefined,
  new LocalDesktopPlanner(store),
);
const report: any = {
  at: new Date().toISOString(),
  status: "NOT RUN",
  evidenceLevel:
    "actual Windows screenshot plus UIA sent to local vision model; not an image-only accuracy benchmark",
};
try {
  await adapter.start();
  const desktop = await adapter.windows();
  const targets = desktop.windows.filter((w: any) => w.title === "Calculator");
  assert.equal(targets.length, 1);
  const id = randomUUID();
  runtime.submit(
    {
      schemaVersion: 1,
      id,
      correlationId: id,
      requester: "evaluation",
      goal: "Read the result currently displayed by Calculator and report the number. Do not change anything or click any controls.",
      target: {
        host: desktop.host,
        session: desktop.session,
        identity: String(targets[0].handle),
      },
      parameters: {
        windowPid: targets[0].pid,
        plannerModel: "qwen3.6:latest",
        vision: true,
      },
      effects: ["edit"],
      requirements: [],
      unresolved: [],
      method: "desktop.assistant",
      expected: {},
      budgets: { steps: 2, deadlineMs: 180000 },
    },
    id,
  );
  await runtime.execute(id);
  const run = store.run(id);
  report.statusAfterPlanning = run.status;
  report.answer = run.bindings.assistantMessage;
  report.error = run.error;
  assert.equal(run.status, "needs_review");
  assert.match(String(report.answer), /518/);
  assert.equal(
    store.events(0, id).filter((e) => e.type === "dispatched").length,
    0,
  );
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  writeFileSync(
    "evidence/desktop-vision.json",
    JSON.stringify(report, null, 2),
  );
  await runtime.close();
  console.log(JSON.stringify(report));
}
