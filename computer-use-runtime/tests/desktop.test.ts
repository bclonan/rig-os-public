import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EnvironmentAdapter } from "../src/contracts/ports.js";
import type {
  Observation,
  Action,
  Receipt,
  TaskContract,
} from "../src/contracts/index.js";
import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { reviewDesktop, type Proposal } from "../src/assistant/runner.js";
import {
  actionStep,
  type DesktopPlanner,
  type Decision,
} from "../src/assistant/planner.js";
import { bitmapToPng } from "../src/adapters/png.js";
import { LocalDesktopPlanner } from "../src/assistant/local.js";

class DesktopDouble implements EnvironmentAdapter {
  host = "test";
  session = "test";
  identity = "1";
  capabilities = ["fill", "invoke", "type", "key", "click"];
  value = "";
  dispatched: Action[] = [];
  failedAfterDelivery = false;
  closed = false;
  index = 0;
  async observe(): Promise<Observation> {
    return {
      schemaVersion: 1,
      id: randomUUID(),
      host: this.host,
      session: this.session,
      target: this.identity,
      at: Date.now(),
      revision: this.value || "empty",
      frame: { x: 10, y: 20, width: 400, height: 300, scale: 1 },
      focused: true,
      facts: { windowHandle: 1, windowTitle: "Test editor" },
      image: "screenshot",
      features: [],
      backend: "unit-test-double",
      controls: [
        {
          index: this.index,
          id: "editor",
          name: "Document",
          value: this.value,
          actions: ["click", "fill"],
          controlType: 50004,
          focused: true,
          offscreen: false,
          bounds: { x: 20, y: 50, width: 380, height: 250 },
        },
      ],
    };
  }
  async acquire() {
    return 1;
  }
  async focus() {}
  async execute(action: Action): Promise<Receipt> {
    this.dispatched.push(action);
    this.value = String(action.args.value || action.args.text || "");
    if (this.failedAfterDelivery)
      throw new Error("Worker disconnected after input");
    return {
      schemaVersion: 1,
      actionId: action.id,
      runId: action.runId,
      backend: "unit-test-double",
      at: Date.now(),
      phase: "acknowledged",
      detail: "input sent",
      timings: {},
    };
  }
  async release() {}
  async takeover() {}
  async returnControl() {}
  async close() {
    this.closed = true;
  }
}
const edit: Decision = {
  kind: "action",
  summary: "Replace the document with hello",
  operation: "fill",
  control: 0,
  text: "hello",
};
function setup(
  planner: DesktopPlanner = {
    next: async (_t, o) =>
      o.controls?.[0].value === "hello"
        ? { kind: "done", summary: "The text is present." }
        : edit,
  },
) {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-desktop-unit-")));
  const adapter = new DesktopDouble();
  const runtime = new Runtime(
    store,
    adapter,
    undefined,
    undefined,
    undefined,
    planner,
  );
  const id = randomUUID();
  const task: TaskContract = {
    schemaVersion: 1,
    id,
    correlationId: id,
    requester: "user",
    goal: "Write hello",
    target: { host: "test", session: "test", identity: "1" },
    parameters: {},
    effects: ["edit", "save"],
    requirements: [],
    unresolved: [],
    method: "desktop.assistant",
    expected: {},
    budgets: { steps: 10, deadlineMs: 60000 },
  };
  runtime.submit(task, id);
  return { store, adapter, runtime, id };
}

test("desktop proposals require a matching human approval and model completion stays unverified", async () => {
  const { store, adapter, runtime, id } = setup();
  try {
    await runtime.execute(id);
    assert.equal(store.run(id).status, "awaiting_approval");
    assert.equal(adapter.dispatched.length, 0);
    await assert.rejects(
      reviewDesktop(runtime, id, { command: "approve", proposalId: "wrong" }),
      /no longer/,
    );
    const p = store.run(id).bindings.proposal as Proposal;
    await reviewDesktop(runtime, id, { command: "approve", proposalId: p.id });
    await runtime.execute(id);
    assert.equal(adapter.dispatched.length, 1);
    assert.equal(store.run(id).status, "needs_review");
    await assert.rejects(
      reviewDesktop(runtime, id, { command: "approve", proposalId: p.id }),
    );
    await reviewDesktop(runtime, id, { command: "confirm" });
    assert.equal(store.run(id).status, "completed_by_user");
    assert.equal(
      store.events(0, id).filter((e) => e.type === "effect_verified").length,
      0,
    );
  } finally {
    await runtime.close();
  }
});
test("changed app state invalidates approval before desktop dispatch", async () => {
  const { store, adapter, runtime, id } = setup();
  try {
    await runtime.execute(id);
    const p = store.run(id).bindings.proposal as Proposal;
    adapter.value = "User's intervening edit";
    await reviewDesktop(runtime, id, { command: "approve", proposalId: p.id });
    await runtime.execute(id);
    assert.equal(adapter.dispatched.length, 0);
    assert.equal(store.run(id).status, "awaiting_approval");
    assert.notEqual((store.run(id).bindings.proposal as Proposal).id, p.id);
    assert.ok(store.events(0, id).some((e) => e.type === "proposal_expired"));
  } finally {
    await runtime.close();
  }
});
test("uncertain desktop delivery is never replayed", async () => {
  const { store, adapter, runtime, id } = setup();
  try {
    await runtime.execute(id);
    adapter.failedAfterDelivery = true;
    await reviewDesktop(runtime, id, {
      command: "approve",
      proposalId: (store.run(id).bindings.proposal as Proposal).id,
    });
    await runtime.execute(id);
    assert.equal(store.run(id).status, "reconciliation_required");
    await runtime.control(id, "pause");
    await runtime.control(id, "resume");
    assert.equal(store.run(id).status, "reconciliation_required");
    assert.equal(adapter.dispatched.length, 1);
  } finally {
    await runtime.close();
  }
});
test("shutdown cancels pending desktop inference and releases the store", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { adapter, runtime, id, store } = setup({
    next: async (_t, _o, _h, signal) => {
      started();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  void runtime.execute(id);
  await ready;
  await runtime.close();
  assert.equal(adapter.closed, true);
  assert.equal(adapter.dispatched.length, 0);
  const reopened = new Store(store.root);
  assert.equal(reopened.run(id).status, "paused");
  reopened.close();
});
test("desktop action parser rejects ungrounded, out-of-window and executable actions", async () => {
  const o = await new DesktopDouble().observe();
  assert.throws(() => actionStep({ ...edit, operation: "shell" }, o, false));
  assert.throws(() => actionStep({ ...edit, control: 999 }, o, false));
  assert.throws(() =>
    actionStep(
      { ...edit, operation: "click", control: undefined, x: 20, y: 20 },
      o,
      false,
    ),
  );
  assert.throws(() =>
    actionStep(
      {
        ...edit,
        operation: "drag",
        control: undefined,
        x: 2,
        y: 2,
        dx: 500,
        dy: 4,
      },
      o,
      true,
    ),
  );
  assert.throws(() =>
    actionStep({ ...edit, operation: "key", key: "Windows+R" }, o, false),
  );
  assert.throws(() =>
    actionStep({ ...edit, operation: "type", text: "x".repeat(129) }, o, false),
  );
  o.controls![0].focused = false;
  assert.throws(() =>
    actionStep({ ...edit, operation: "type", text: "hello" }, o, false),
  );
});
test("native screenshot encoder emits a valid PNG header and rejects truncated bitmaps", () => {
  const bmp = Buffer.alloc(58);
  bmp.write("BM");
  bmp.writeUInt32LE(54, 10);
  bmp.writeInt32LE(1, 18);
  bmp.writeInt32LE(-1, 22);
  bmp.writeUInt16LE(32, 28);
  bmp[56] = 255;
  const png = bitmapToPng(bmp);
  assert.equal(png.toString("ascii", 1, 4), "PNG");
  assert.equal(png.readUInt32BE(16), 1);
  assert.equal(png.readUInt32BE(20), 1);
  assert.throws(() => bitmapToPng(bmp.subarray(0, 56)), /dimensions/);
});
test("local plans rebind named controls after index changes and user feedback invalidates queued steps", async () => {
  let local!: LocalDesktopPlanner;
  const { store, adapter, runtime, id } = setup({
    next: (...args) => local.next(...args),
  });
  local = new LocalDesktopPlanner(store);
  const run = store.run(id);
  run.contract.parameters.plannerModel = "unit-model";
  store.putRun(run);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/show"))
      return Response.json({ capabilities: ["completion"] });
    calls++;
    const result =
      calls === 1
        ? {
            kind: "plan",
            summary: "Edit twice",
            actions: [
              { ...edit, control: "editor" },
              { ...edit, control: "editor", text: "second" },
            ],
          }
        : {
            kind: "question",
            summary: "What new text should I use?",
            actions: [],
          };
    return Response.json({ message: { content: JSON.stringify(result) } });
  };
  try {
    await runtime.execute(id);
    const first = store.run(id).bindings.proposal as Proposal;
    await reviewDesktop(runtime, id, {
      command: "approve",
      proposalId: first.id,
    });
    await runtime.execute(id);
    assert.equal(calls, 1);
    assert.equal(
      (store.run(id).bindings.proposal as Proposal).decision.text,
      "second",
    );
    // Rebinding uses the current ID lookup, not the model's old numeric index.
    adapter.index = 17;
    const rebound = await local.next(
      run.contract,
      await adapter.observe(),
      [],
      new AbortController().signal,
    );
    assert.equal(rebound.control, 17);
    await reviewDesktop(runtime, id, {
      command: "continue",
      feedback: "Change the remaining text.",
    });
    await runtime.execute(id);
    assert.equal(calls, 2);
    assert.equal(store.run(id).status, "awaiting_input");
    assert.equal(adapter.dispatched.length, 1);
    assert.equal(store.run(id).contract.parameters.feedback, undefined);
  } finally {
    globalThis.fetch = original;
    await runtime.close();
  }
});
