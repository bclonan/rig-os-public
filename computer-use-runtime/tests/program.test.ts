import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { seedForm, seal } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import type { SkillCapsule } from "../src/contracts/index.js";
import { Recorder } from "../src/recorder/index.js";

async function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-program-")));
  const adapter = await new BrowserAdapter(store).start();
  const runtime = new Runtime(store, adapter);
  const task = structuredTask(
    "Use a bounded workflow",
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    { name: "Branch Willow" },
  );
  const skill = seedForm();
  skill.preconditions = [];
  skill.budgets = { retries: 1, steps: 20 };
  task.budgets.steps = 20;
  async function run() {
    runtime.registry.put(seal(skill));
    runtime.submit(task, task.id);
    await runtime.execute(task.id);
    return store.run(task.id);
  }
  return { store, adapter, runtime, task, skill, run };
}
function dismiss(): SkillCapsule["machine"]["states"][number] {
  return {
    id: "dismiss",
    monitor: ["focused"],
    steps: [
      {
        id: "dismiss",
        operation: "click",
        scope: "edit",
        args: { locator: "dismiss" },
        guard: "dialog",
      },
    ],
    next: "edit",
  };
}

test("state monitors reject unknown facts before any effect", async () => {
  const s = await setup();
  try {
    s.skill.machine.states[0].monitor = ["unproved-condition"];
    const run = await s.run();
    assert.equal(run.status, "blocked");
    assert.match(run.error!, /monitor/);
    assert.equal(
      s.store.events(0, run.id).filter((e) => e.type === "dispatched").length,
      0,
    );
  } finally {
    await s.runtime.close();
  }
});

test("fresh guarded branches repair a real modal before the shared continuation", async () => {
  const s = await setup();
  try {
    await s.adapter.reset("dialog");
    s.skill.machine.initial = "choose";
    s.skill.machine.states.unshift(
      {
        id: "choose",
        monitor: ["focused"],
        steps: [],
        transitions: [{ guard: "dialog", target: "dismiss" }],
        next: "edit",
      },
      dismiss(),
    );
    const run = await s.run();
    assert.equal(
      run.status,
      "succeeded",
      run.error || "Expected objective completion",
    );
    assert.equal((await s.adapter.observe()).facts.result, "Branch Willow");
    assert.equal(
      s.store.events(0, run.id).filter((e) => e.type === "transition").length,
      1,
    );
  } finally {
    await s.runtime.close();
  }
});

test("an explicit recovery handler runs only before dispatch and spends its retry budget", async () => {
  const s = await setup();
  try {
    await s.adapter.reset("dialog");
    s.skill.machine.states[0].steps[0].guard = "ready";
    s.skill.machine.states[0].onError = "dismiss";
    s.skill.machine.states.push(dismiss());
    const run = await s.run();
    assert.equal(
      run.status,
      "succeeded",
      run.error || "Expected objective completion",
    );
    assert.equal(run.bindings.recoveryAttempts, 1);
    const journal = s.store.events(0, run.id);
    assert.equal(journal.filter((e) => e.type === "recovery").length, 1);
    assert.equal(journal.filter((e) => e.type === "dispatched").length, 3);
  } finally {
    await s.runtime.close();
  }
});

test("delivery uncertainty never enters a recovery state", async () => {
  const s = await setup();
  try {
    s.skill.machine.states[0].onError = "dismiss";
    s.skill.machine.states.push(dismiss());
    const execute = s.adapter.execute.bind(s.adapter);
    s.adapter.execute = async (action, signal) => {
      await execute(action, signal);
      throw new Error("receipt lost after effect");
    };
    const run = await s.run();
    assert.equal(run.status, "reconciliation_required");
    assert.equal(
      s.store.events(0, run.id).filter((e) => e.type === "recovery").length,
      0,
    );
    assert.equal((await s.adapter.observe()).facts.name, "Branch Willow");
  } finally {
    await s.runtime.close();
  }
});

test("runtime rejects a receipt for another action before advancing the program", async () => {
  const s = await setup();
  try {
    const execute = s.adapter.execute.bind(s.adapter);
    s.adapter.execute = async (action, signal) => ({
      ...(await execute(action, signal)),
      actionId: "another-action",
      runId: "another-run",
    });
    const run = await s.run();
    assert.equal(run.status, "reconciliation_required");
    assert.equal(run.cursor, 0);
    assert.equal(
      s.store.events(0, run.id).filter((e) => e.type === "acknowledged").length,
      0,
    );
  } finally {
    await s.runtime.close();
  }
});

test("an explicit bound rejection cannot be accepted as input delivery", async () => {
  const s = await setup();
  try {
    s.adapter.execute = async (action) => ({
      schemaVersion: 1,
      actionId: action.id,
      runId: action.runId,
      backend: "test-rejection",
      phase: "rejected",
      dispatched: false,
      at: Date.now(),
      detail: "Host rejected input before delivery",
      timings: {},
    });
    const run = await s.run();
    assert.equal(run.status, "blocked");
    assert.equal(run.cursor, 0);
    assert.equal((await s.adapter.observe()).facts.name, "");
    assert.equal(
      s.store.events(0, run.id).filter((e) => e.type === "acknowledged").length,
      0,
    );
    assert.equal(
      s.store.events(0, run.id).filter((e) => e.type === "uncertain").length,
      0,
    );
  } finally {
    await s.runtime.close();
  }
});

test("unknown effects remain reconciliation-only after pause and resume and never become positive data", async () => {
  const s = await setup();
  try {
    s.skill.machine.states[0].steps[0].verify = "missing-effect-detector";
    let calls = 0;
    const execute = s.adapter.execute.bind(s.adapter);
    s.adapter.execute = async (action, signal) => {
      calls++;
      return execute(action, signal);
    };
    const run = await s.run();
    assert.equal(run.status, "reconciliation_required");
    await s.runtime.control(run.id, "pause");
    assert.equal(
      (await s.runtime.control(run.id, "resume")).status,
      "reconciliation_required",
    );
    assert.equal(calls, 1);
    await s.adapter.page.locator("#apply").click();
    assert.equal(
      (await s.runtime.control(run.id, "reconcile")).status,
      "succeeded",
    );
    const recorded = new Recorder(s.store).capture(run.id);
    assert.equal(recorded.verified, false);
    assert.equal(recorded.steps[0].label, "unknown");
  } finally {
    await s.runtime.close();
  }
});

test("independent final verification invokes an explicit bounded repair then re-verifies", async () => {
  const s = await setup();
  try {
    s.skill.machine.onVerificationError = "repair-final";
    s.skill.machine.states = [
      s.skill.machine.states[0],
      {
        id: "repair-final",
        monitor: ["focused"],
        steps: seedForm().machine.states[1].steps,
      },
    ];
    delete s.skill.machine.states[0].next;
    const run = await s.run();
    assert.equal(
      run.status,
      "succeeded",
      run.error || "Expected verified repair",
    );
    assert.equal(run.bindings.recoveryAttempts, 1);
    assert.equal(
      s.store
        .events(0, run.id)
        .filter((e) => e.type === "verification_recovery").length,
      1,
    );
    assert.equal(
      s.store.events(0, run.id).filter((e) => e.type === "verification").length,
      2,
    );
  } finally {
    await s.runtime.close();
  }
});

test("repeated final-verification failure stops repair when the artifact does not change", async () => {
  const s = await setup();
  try {
    s.skill.budgets.retries = 5;
    s.skill.machine.onVerificationError = "repair-final";
    s.skill.machine.states = [
      s.skill.machine.states[0],
      {
        id: "repair-final",
        monitor: ["focused"],
        steps: [
          { id: "observe", operation: "observe", scope: "edit", args: {} },
        ],
      },
    ];
    delete s.skill.machine.states[0].next;
    const run = await s.run();
    assert.equal(run.status, "blocked");
    assert.match(run.error!, /no progress/);
    assert.equal(run.bindings.recoveryAttempts, 1);
  } finally {
    await s.runtime.close();
  }
});

test("entry monitors apply to empty terminal states", async () => {
  const s = await setup();
  try {
    s.skill.machine = {
      initial: "check",
      states: [{ id: "check", steps: [], monitor: ["unknown-monitor"] }],
    };
    assert.equal((await s.run()).status, "blocked");
    assert.equal(
      s.store.events(0, s.task.id).filter((e) => e.type === "dispatched")
        .length,
      0,
    );
  } finally {
    await s.runtime.close();
  }
});

test("foreign after-action observations cannot verify completion or permit replay", async () => {
  const s = await setup();
  try {
    const observe = s.adapter.observe.bind(s.adapter);
    let delivered = false;
    const execute = s.adapter.execute.bind(s.adapter);
    s.adapter.execute = async (action, signal) => {
      const receipt = await execute(action, signal);
      delivered = true;
      return receipt;
    };
    s.adapter.observe = async (signal) => {
      const observation = await observe(signal);
      return delivered
        ? {
            ...observation,
            host: "foreign-host",
            target: "foreign-document",
            facts: { result: "Branch Willow" },
          }
        : observation;
    };
    const run = await s.run();
    assert.equal(run.status, "reconciliation_required");
    assert.equal(run.cursor, 0);
    await assert.rejects(
      s.runtime.control(run.id, "reconcile"),
      /authorized host/,
    );
    await s.runtime.control(run.id, "pause");
    assert.equal(
      (await s.runtime.control(run.id, "resume")).status,
      "reconciliation_required",
    );
    assert.equal(
      s.store.events(0, run.id).filter((e) => e.type === "dispatched").length,
      1,
    );
  } finally {
    await s.runtime.close();
  }
});

test("a known failed effect enters bounded repair and never becomes a positive recording step", async () => {
  const s = await setup();
  try {
    const execute = s.adapter.execute.bind(s.adapter);
    const observe = s.adapter.observe.bind(s.adapter);
    let calls = 0;
    s.adapter.execute = async (action, signal) => {
      if (++calls !== 1) return execute(action, signal);
      return {
        schemaVersion: 1,
        actionId: action.id,
        runId: action.runId,
        backend: "injected-no-effect",
        phase: "acknowledged",
        at: Date.now(),
        detail: "Delivered action had no effect",
        timings: {},
      };
    };
    s.adapter.observe = async (signal) => {
      const observation = await observe(signal);
      observation.facts.nameCorrect =
        observation.facts.name === s.task.parameters.name;
      return observation;
    };
    s.skill.machine.states[0].steps[0].verify = "nameCorrect";
    s.skill.machine.states[0].onError = "repair";
    s.skill.machine.states.push({
      id: "repair",
      monitor: ["focused"],
      steps: seedForm().machine.states.flatMap((state) => state.steps),
    });
    const run = await s.run();
    assert.equal(run.status, "succeeded", run.error || "Expected completion");
    assert.equal(run.bindings.recoveryAttempts, 1);
    assert.equal(calls, 3);
    assert.equal(
      s.store.events(0, run.id).filter((e) => e.type === "uncertain").length,
      0,
    );
    const recorded = new Recorder(s.store).capture(run.id);
    assert.equal(recorded.steps[0].label, "failure");
    assert.equal(recorded.verified, false);
  } finally {
    await s.runtime.close();
  }
});

test("predicate waits resume after an observed environment change without sending input", async () => {
  const s = await setup();
  try {
    await s.adapter.reset("closed");
    s.skill.machine.states[0].steps.unshift({
      id: "wait-ready",
      operation: "wait",
      args: {},
      scope: "edit",
      waitFor: "ready",
      waitMs: 1500,
    });
    const change = delay(250).then(() =>
      s.adapter.page.evaluate(() => {
        document.querySelector<HTMLElement>("#editor")!.hidden = false;
      }),
    );
    const run = await s.run();
    await change;
    assert.equal(
      run.status,
      "succeeded",
      run.error || "Expected objective completion",
    );
    const journal = s.store.events(0, run.id);
    assert.equal(journal.filter((e) => e.type === "wait_satisfied").length, 1);
    assert.equal(journal.filter((e) => e.type === "dispatched").length, 2);
  } finally {
    await s.runtime.close();
  }
});

test("predicate waits time out on UNKNOWN and monitor failure interrupts a timer", async () => {
  for (const monitorFailure of [false, true]) {
    const s = await setup();
    try {
      s.skill.machine.states[0].steps.unshift({
        id: "wait",
        operation: "wait",
        args: {},
        scope: "edit",
        waitMs: monitorFailure ? 5000 : 100,
        ...(monitorFailure ? {} : { waitFor: "unknown-event" }),
      });
      if (monitorFailure) s.skill.machine.states[0].monitor = ["ready"];
      const change = monitorFailure
        ? delay(200).then(() =>
            s.adapter.page.evaluate(() => {
              document.querySelector<HTMLElement>("#editor")!.hidden = true;
            }),
          )
        : Promise.resolve();
      const start = Date.now();
      const run = await s.run();
      await change;
      assert.equal(run.status, "blocked");
      assert.match(run.error!, monitorFailure ? /monitor/ : /Wait expired/);
      assert.ok(Date.now() - start < 3000);
      assert.equal(
        s.store.events(0, run.id).filter((e) => e.type === "dispatched").length,
        0,
      );
    } finally {
      await s.runtime.close();
    }
  }
});

test("cycles exhaust a persisted budget including states with no actions", async () => {
  for (const withBranch of [false, true]) {
    const s = await setup();
    try {
      s.skill.machine = {
        initial: "cycle",
        states: [
          {
            id: "cycle",
            monitor: [],
            steps: [],
            ...(withBranch
              ? { transitions: [{ guard: "ready", target: "cycle" }] }
              : { next: "cycle" }),
          },
        ],
      };
      const run = await s.run();
      assert.equal(run.status, "blocked");
      assert.match(run.error!, /budget exceeded/);
      assert.equal(
        s.store.events(0, run.id).filter((e) => e.type === "dispatched").length,
        0,
      );
    } finally {
      await s.runtime.close();
    }
  }
});

test("nested invocation binds typed child inputs without changing task parameters", async () => {
  const s = await setup();
  try {
    const child = seedForm();
    child.id = "nested.child";
    child.inputs = { title: "string" };
    child.machine.states[0].steps[0].args.value = "$title";
    s.runtime.registry.put(seal(child));
    s.skill.dependencies = [child.id];
    s.skill.machine = {
      initial: "call",
      states: [
        {
          id: "call",
          monitor: ["focused"],
          steps: [
            {
              id: "child",
              operation: "subskill",
              subskill: child.id,
              scope: "edit",
              args: { title: "$name" },
            },
          ],
        },
      ],
    };
    const run = await s.run();
    assert.equal(
      run.status,
      "succeeded",
      run.error || "Expected objective completion",
    );
    assert.deepEqual(run.contract.parameters, { name: "Branch Willow" });
  } finally {
    await s.runtime.close();
  }
});
