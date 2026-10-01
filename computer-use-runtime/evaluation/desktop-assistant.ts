import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/storage/index.js";
import { DesktopRouter } from "../src/adapters/desktop.js";
import { Runtime } from "../src/runtime/index.js";
import { LocalDesktopPlanner } from "../src/assistant/local.js";
import { service } from "../src/service/index.js";

const store = new Store(mkdtempSync(join(tmpdir(), "cur-desktop-live-")));
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
const report: any = {
  at: new Date().toISOString(),
  status: "NOT RUN",
  evidenceLevel:
    "actual Windows Calculator, local Ollama model, shared HTTP API and runtime",
  actions: [],
  store: store.root,
};
async function api(url: string, body?: unknown) {
  const response = await app.inject({
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
  if (response.statusCode >= 400) throw new Error(response.body);
  return response.json();
}
try {
  await adapter.start();
  const windows = await api("/api/desktop/windows");
  const calculator = windows.windows.filter(
    (w: any) => w.title === "Calculator",
  );
  assert.equal(calculator.length, 1, "Open exactly one Windows Calculator");
  const model = process.env.CUR_TEST_MODEL || "qwen3.6:latest";
  report.model = model;
  const created = await api("/api/desktop/tasks", {
    goal: "Calculate 37 times 14 using the Calculator buttons. Start by clearing the previous calculation. Stop when the result is displayed.",
    model,
    vision: false,
    handle: calculator[0].handle,
    pid: calculator[0].pid,
  });
  report.runId = created.id;
  for (let step = 0; step < 18; step++) {
    await runtime.execute(created.id);
    const run = store.run(created.id);
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
    const proposal: any = run.bindings.proposal;
    const control = proposal.observation.controls.find(
      (c: any) => c.index === proposal.decision.control,
    );
    // Evaluation may approve only the calculator's ordinary numeric operations.
    assert.ok(["invoke", "click"].includes(proposal.decision.operation));
    assert.match(
      control?.id || "",
      /^(num\dButton|clearButton|clearEntryButton|multiplyButton|equalButton)$/,
    );
    report.actions.push({ decision: proposal.decision, control: control.id });
    await api(`/api/desktop/tasks/${run.id}/review`, {
      command: "approve",
      proposalId: proposal.id,
    });
  }
  const observed = await adapter.observe();
  report.result = observed.facts["uia.CalculatorResults"];
  assert.equal(report.result, "Display is 518");
  assert.equal(
    report.finalStatus,
    "needs_review",
    "Model completion must remain unverified",
  );
  const run = store.run(created.id);
  await api(`/api/desktop/tasks/${run.id}/review`, { command: "confirm" });
  assert.equal(store.run(run.id).status, "completed_by_user");
  report.independentCalculatorCheck = true;
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  writeFileSync(
    "evidence/desktop-assistant.json",
    JSON.stringify(report, null, 2),
  );
  await app.close();
  console.log(JSON.stringify(report, null, 2));
}
