import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { reviewDesktop, type Proposal } from "../src/assistant/runner.js";
import type {
  Action,
  Receipt,
  Observation,
  TaskContract,
} from "../src/contracts/index.js";

class OwnedEditor {
  host = "fixture";
  session = "fixture";
  identity = "editor";
  capabilities = ["fill"];
  value = "";
  index = 0;
  rejectsRemaining = 1;
  proof: boolean | undefined = false;
  wrongActionId = false;
  releaseFails = false;
  deliverBeforeReject = false;
  attempts: Action[] = [];
  effects = 0;
  releases = 0;
  async observe(): Promise<Observation> {
    return {
      schemaVersion: 1,
      id: randomUUID(),
      host: this.host,
      session: this.session,
      target: this.identity,
      at: Date.now(),
      revision: this.value || "empty",
      focused: true,
      frame: { x: 0, y: 0, width: 400, height: 300, scale: 1 },
      facts: { windowHandle: 1, windowTitle: "Disposable editor" },
      features: [],
      backend: "test-double",
      controls: [
        {
          index: this.index,
          id: "text",
          name: "Document",
          value: this.value,
          actions: ["fill"],
          controlType: 50004,
          focused: true,
          offscreen: false,
          bounds: { x: 10, y: 10, width: 380, height: 280 },
        },
      ],
    };
  }
  async acquire() {
    return 1;
  }
  async focus() {}
  async execute(action: Action): Promise<Receipt> {
    this.attempts.push(action);
    if (this.rejectsRemaining-- > 0) {
      this.index = 9;
      if (this.deliverBeforeReject) {
        this.value = String(action.args.value);
        this.effects++;
      }
      return {
        schemaVersion: 1,
        actionId: this.wrongActionId ? randomUUID() : action.id,
        runId: action.runId,
        phase: "rejected",
        dispatched: this.proof,
        backend: "test-double",
        at: Date.now(),
        detail: "Target content changed after observation",
        timings: {},
      };
    }
    this.value = String(action.args.value);
    this.effects++;
    return {
      schemaVersion: 1,
      actionId: action.id,
      runId: action.runId,
      phase: "acknowledged",
      backend: "test-double",
      at: Date.now(),
      detail: "Sent",
      timings: {},
    };
  }
  async release() {
    this.releases++;
    if (this.releaseFails) throw new Error("Unconfirmed input release");
  }
  async takeover() {}
  async returnControl() {}
  async close() {}
}
function setup(steps = 5) {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "cur-desktop-rejection-")),
  );
  const adapter = new OwnedEditor();
  let plannerCalls = 0;
  const runtime = new Runtime(store, adapter, undefined, undefined, undefined, {
    next: async (_t, o) => {
      plannerCalls++;
      return adapter.value === "hello"
        ? { kind: "done" as const, summary: "Text is present" }
        : {
            kind: "action" as const,
            operation: "fill",
            control: o.controls![0].index,
            text: "hello",
            summary: "Write hello",
          };
    },
  });
  const id = randomUUID();
  const task: TaskContract = {
    schemaVersion: 1,
    id,
    correlationId: id,
    requester: "test-user",
    goal: "Write hello",
    target: {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    parameters: {},
    requirements: [],
    unresolved: [],
    effects: ["edit"],
    expected: {},
    method: "desktop.assistant",
    budgets: { steps, deadlineMs: 60000 },
  };
  runtime.submit(task, id);
  const approve = async () => {
    const proposal = store.run(id).bindings.proposal as Proposal;
    await reviewDesktop(runtime, id, {
      command: "approve",
      proposalId: proposal.id,
    });
    await runtime.execute(id);
    return proposal;
  };
  return {
    store,
    adapter,
    runtime,
    id,
    approve,
    plannerCalls: () => plannerCalls,
  };
}

test("known no-input refusal releases control and needs a new approval against fresh controls", async () => {
  const s = setup();
  try {
    await s.runtime.execute(s.id);
    const old = await s.approve();
    const run = s.store.run(s.id);
    assert.equal(run.status, "awaiting_approval");
    assert.equal(s.adapter.attempts.length, 1);
    assert.equal(s.adapter.effects, 0);
    assert.equal(run.cursor, 0);
    assert.equal(run.bindings.nonDeliveredAttempts, 1);
    const fresh = run.bindings.proposal as Proposal;
    assert.notEqual(fresh.id, old.id);
    assert.notEqual(fresh.observation.id, old.observation.id);
    assert.equal(fresh.decision.control, 9);
    assert.ok(s.adapter.releases >= 2);
    await assert.rejects(
      reviewDesktop(s.runtime, s.id, {
        command: "approve",
        proposalId: old.id,
      }),
    );
    assert.equal(s.adapter.attempts.length, 1);
    await s.approve();
    assert.equal(s.store.run(s.id).status, "needs_review");
    assert.equal(s.adapter.attempts.length, 2);
    assert.notEqual(s.adapter.attempts[0].id, s.adapter.attempts[1].id);
    assert.equal(s.adapter.effects, 1);
    assert.equal(s.adapter.value, "hello");
    assert.equal(s.store.run(s.id).cursor, 1);
    assert.equal(
      s.store.events(0, s.id).filter((e) => e.type === "acknowledged").length,
      1,
    );
    assert.equal(
      s.store.events(0, s.id).filter((e) => e.type === "uncertain").length,
      0,
    );
  } finally {
    await s.runtime.close();
  }
});

test("repeated no-input refusals consume the durable action budget without effect or automatic retry", async () => {
  const s = setup(2);
  s.adapter.rejectsRemaining = Infinity;
  try {
    await s.runtime.execute(s.id);
    await s.approve();
    assert.equal(s.store.run(s.id).status, "awaiting_approval");
    await s.approve();
    const run = s.store.run(s.id);
    assert.equal(run.status, "blocked");
    assert.match(run.error!, /budget/);
    assert.equal(run.cursor, 0);
    assert.equal(run.bindings.nonDeliveredAttempts, 2);
    assert.equal(s.adapter.attempts.length, 2);
    assert.equal(s.adapter.effects, 0);
    assert.equal(s.plannerCalls(), 2);
    assert.equal(
      s.store.events(0, s.id).filter((e) => e.type === "acknowledged").length,
      0,
    );
  } finally {
    await s.runtime.close();
  }
});

test("rejected receipt without no-dispatch proof cannot produce another proposal", async () => {
  const s = setup();
  s.adapter.proof = undefined;
  try {
    await s.runtime.execute(s.id);
    await s.approve();
    assert.equal(s.store.run(s.id).status, "reconciliation_required");
    assert.equal(s.plannerCalls(), 1);
    assert.equal(s.adapter.attempts.length, 1);
    assert.equal(s.adapter.effects, 0);
    assert.equal(s.store.run(s.id).bindings.proposal, undefined);
  } finally {
    await s.runtime.close();
  }
});

test("wrong rejected action identity remains uncertain and never replans", async () => {
  const s = setup();
  s.adapter.wrongActionId = true;
  try {
    await s.runtime.execute(s.id);
    await s.approve();
    assert.equal(s.store.run(s.id).status, "reconciliation_required");
    assert.equal(s.plannerCalls(), 1);
    assert.equal(s.adapter.attempts.length, 1);
    await s.runtime.execute(s.id);
    assert.equal(s.adapter.attempts.length, 1);
  } finally {
    await s.runtime.close();
  }
});

test("delivered input followed by an ambiguous rejection survives reopen without continue or replay", async () => {
  const s = setup();
  s.adapter.proof = undefined;
  s.adapter.deliverBeforeReject = true;
  await s.runtime.execute(s.id);
  await s.approve();
  assert.equal(s.store.run(s.id).status, "reconciliation_required");
  assert.equal(s.adapter.effects, 1);
  assert.equal(s.plannerCalls(), 1);
  assert.equal(s.store.run(s.id).bindings.nonDeliveredAttempts, undefined);
  assert.equal(
    s.store.events(0, s.id).filter((event) => event.type === "uncertain")
      .length,
    1,
  );
  await assert.rejects(
    reviewDesktop(s.runtime, s.id, {
      command: "continue",
      feedback: "try again",
    }),
  );
  await s.runtime.close();
  const reopened = new Store(s.store.root);
  const runtime = new Runtime(
    reopened,
    s.adapter,
    undefined,
    undefined,
    undefined,
    {
      next: async () => {
        throw new Error("Uncertain tasks must not replan");
      },
    },
  );
  try {
    await runtime.execute(s.id);
    await runtime.control(s.id, "pause");
    await runtime.control(s.id, "resume");
    await runtime.execute(s.id);
    await assert.rejects(
      reviewDesktop(runtime, s.id, {
        command: "continue",
        feedback: "try again",
      }),
    );
    assert.equal(reopened.run(s.id).status, "reconciliation_required");
    assert.equal(s.adapter.effects, 1);
    assert.equal(s.adapter.attempts.length, 1);
  } finally {
    await runtime.close();
  }
});

test("contradictory rejected receipt remains uncertain and never replans", async () => {
  const s = setup();
  s.adapter.proof = true;
  try {
    await s.runtime.execute(s.id);
    await s.approve();
    assert.equal(s.store.run(s.id).status, "reconciliation_required");
    assert.equal(s.plannerCalls(), 1);
    assert.equal(s.adapter.attempts.length, 1);
    assert.equal(s.store.run(s.id).bindings.nonDeliveredAttempts, undefined);
    await s.runtime.execute(s.id);
    assert.equal(s.adapter.attempts.length, 1);
  } finally {
    await s.runtime.close();
  }
});

test("restarting the store does not reset the no-input refusal budget", async () => {
  const s = setup(2);
  s.adapter.rejectsRemaining = Infinity;
  await s.runtime.execute(s.id);
  await s.approve();
  const previousProposal = s.store.run(s.id).bindings.proposal as Proposal;
  await s.runtime.close();
  const reopened = new Store(s.store.root);
  let calls = 0;
  const runtime = new Runtime(
    reopened,
    s.adapter,
    undefined,
    undefined,
    undefined,
    {
      next: async () => {
        calls++;
        throw new Error("Exhausted actions must not request another plan");
      },
    },
  );
  try {
    assert.equal(reopened.run(s.id).bindings.nonDeliveredAttempts, 1);
    assert.equal(
      Number(reopened.run(s.id).bindings.deadlineAt) > Date.now(),
      true,
    );
    await reviewDesktop(runtime, s.id, {
      command: "approve",
      proposalId: previousProposal.id,
    });
    await runtime.execute(s.id);
    assert.equal(reopened.run(s.id).status, "blocked");
    assert.match(reopened.run(s.id).error!, /budget/);
    assert.equal(reopened.run(s.id).bindings.nonDeliveredAttempts, 2);
    assert.equal(reopened.run(s.id).cursor, 0);
    assert.equal(s.adapter.effects, 0);
    assert.equal(s.adapter.attempts.length, 2);
    assert.equal(calls, 0);
  } finally {
    await runtime.close();
  }
});

test("cleanup failure after a no-input refusal blocks new planning and session admission", async () => {
  const s = setup();
  try {
    await s.runtime.execute(s.id);
    s.adapter.releaseFails = true;
    await s.approve();
    assert.equal(s.store.run(s.id).status, "reconciliation_required");
    assert.equal(s.plannerCalls(), 1);
    assert.equal(s.adapter.attempts.length, 1);
    assert.equal(s.adapter.effects, 0);
    assert.ok(s.store.events(0, s.id).some((e) => e.type === "cleanup_failed"));
  } finally {
    s.adapter.releaseFails = false;
    // Shutdown must still report the unacknowledged cleanup failure even when
    // the driver has already recorded it and stopped accepting input.
    await assert.rejects(s.runtime.close(), /Unconfirmed input release/);
  }
});

test("an uncertainty journal failure still requires reconciliation without replanning", async () => {
  const s = setup();
  s.adapter.proof = undefined;
  s.adapter.deliverBeforeReject = true;
  const append = s.store.append.bind(s.store);
  try {
    await s.runtime.execute(s.id);
    s.store.append = (...args) => {
      if (args[1] === "uncertain")
        throw new Error("Injected uncertainty journal failure");
      return append(...args);
    };
    await s.approve();
    assert.equal(s.store.run(s.id).status, "reconciliation_required");
    assert.equal(s.plannerCalls(), 1);
    assert.equal(s.adapter.effects, 1);
    await assert.rejects(
      reviewDesktop(s.runtime, s.id, {
        command: "continue",
        feedback: "again",
      }),
    );
    await s.runtime.control(s.id, "pause");
    await s.runtime.control(s.id, "resume");
    await s.runtime.execute(s.id);
    assert.equal(s.adapter.attempts.length, 1);
  } finally {
    s.store.append = append;
    await s.runtime.close();
  }
});
