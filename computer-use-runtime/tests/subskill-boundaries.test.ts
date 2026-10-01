import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Runtime } from "../src/runtime/index.js";
import { Store } from "../src/storage/index.js";
import { seedForm, seal } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import type {
  Action,
  Observation,
  Receipt,
  SkillCapsule,
} from "../src/contracts/index.js";

class SafeForm {
  host = "safe-test-host";
  session = "safe-test-session";
  identity = "browser-fixture-v1";
  capabilities = ["fill", "click"];
  allowed: boolean | undefined = true;
  verified: boolean | undefined = true;
  value = "";
  result = "";
  fills = 0;
  clicks = 0;
  rejected = 0;
  proof: boolean | undefined = false;
  deliverBeforeReject = false;
  repeatOnce = false;
  actions: Action[] = [];
  async observe(): Promise<Observation> {
    return {
      schemaVersion: 1,
      id: randomUUID(),
      host: this.host,
      session: this.session,
      target: this.identity,
      at: Date.now(),
      revision: this.value || "empty",
      frame: { x: 0, y: 0, width: 100, height: 100, scale: 1 },
      focused: true,
      facts: {
        ready: true,
        focused: true,
        result: this.result,
        ...(this.allowed === undefined ? {} : { allowed: this.allowed }),
        ...(this.verified === undefined ? {} : { callVerified: this.verified }),
        again: this.repeatOnce && this.clicks === 1,
      },
      features: [],
      backend: "safe-double",
    };
  }
  async acquire() {
    return 1;
  }
  async execute(action: Action): Promise<Receipt> {
    this.actions.push(action);
    const receipt = {
      schemaVersion: 1 as const,
      actionId: action.id,
      runId: action.runId,
      at: Date.now(),
      backend: "safe-double",
      detail: "safe mock",
      timings: {},
    };
    const write = () => {
      if (action.operation === "fill") {
        this.value = String(action.args.value);
        this.fills++;
      }
      if (action.operation === "click") {
        this.clicks++;
        if (action.args.locator === "repair") this.verified = true;
        else if (action.args.locator === "enable") this.allowed = true;
        else this.result = this.value;
      }
    };
    if (this.rejected-- > 0) {
      if (this.deliverBeforeReject) write();
      return {
        ...receipt,
        phase: "rejected",
        ...(this.proof === undefined ? {} : { dispatched: this.proof }),
      };
    }
    write();
    return { ...receipt, phase: "acknowledged", dispatched: true };
  }
  async release() {}
  async takeover() {}
  async returnControl() {}
  async close() {}
}
function setup() {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "cur-subskill-boundary-")),
  );
  const adapter = new SafeForm(),
    runtime = new Runtime(store, adapter);
  const child = seedForm();
  child.id = "child.form";
  child.preconditions = [];
  child.budgets = { steps: 2, retries: 1 };
  const parent = seedForm();
  parent.id = "parent.form";
  parent.preconditions = [];
  parent.budgets = { steps: 20, retries: 2 };
  parent.dependencies = [child.id];
  parent.machine = {
    initial: "call",
    states: [
      {
        id: "call",
        monitor: [],
        steps: [
          {
            id: "child",
            operation: "subskill",
            subskill: child.id,
            scope: "edit",
            args: { name: "$name" },
            guard: "allowed",
            verify: "callVerified",
          },
        ],
      },
    ],
  };
  const task = structuredTask(
    "Safe form boundary",
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    { name: "Bound Cedar" },
    parent.id,
  );
  task.budgets.steps = 20;
  task.budgets.deadlineMs = 60000;
  const run = async () => {
    runtime.registry.put(seal(child));
    runtime.registry.put(seal(parent));
    runtime.submit(task, task.id);
    await runtime.execute(task.id);
    return store.run(task.id);
  };
  return { store, adapter, runtime, child, parent, task, run };
}

test("FALSE and UNKNOWN subskill entry guards prevent all child input", async () => {
  for (const truth of [false, undefined]) {
    const s = setup();
    s.adapter.allowed = truth;
    try {
      assert.equal((await s.run()).status, "blocked");
      assert.equal(s.adapter.actions.length, 0);
      assert.equal(
        s.store.run(s.task.id).bindings.invocationBudgets,
        undefined,
      );
    } finally {
      await s.runtime.close();
    }
  }
});

test("TRUE subskill guard permits typed child work and fresh TRUE return verification", async () => {
  const s = setup();
  try {
    const run = await s.run();
    assert.equal(run.status, "succeeded", run.error || "Unexpected run state");
    assert.equal(s.adapter.result, "Bound Cedar");
    assert.equal(s.adapter.actions.length, 2);
    assert.equal(
      s.store
        .events(0, run.id)
        .filter((event) => event.type === "subskill_verification").length,
      1,
    );
  } finally {
    await s.runtime.close();
  }
});

test("FALSE and UNKNOWN subskill return verification cannot certify the caller", async () => {
  for (const truth of [false, undefined]) {
    const s = setup();
    s.adapter.verified = truth;
    s.parent.machine.states[0].onError = "repair";
    s.parent.machine.states.push({
      id: "repair",
      monitor: [],
      steps: [
        {
          id: "repair",
          operation: "click",
          scope: "edit",
          args: { locator: "repair" },
        },
      ],
    });
    try {
      const run = await s.run();
      assert.equal(
        run.status,
        truth === false ? "succeeded" : "reconciliation_required",
        run.error || "Unexpected run state",
      );
      assert.equal(s.adapter.fills, 1);
      assert.equal(s.adapter.clicks, truth === false ? 2 : 1);
      const recovery = s.store
        .events(0, run.id)
        .filter((event) => event.type === "recovery");
      assert.equal(recovery.length, truth === false ? 1 : 0);
      if (truth === false)
        assert.match(JSON.stringify(recovery[0].data), /root\/repair/);
      else {
        await s.runtime.control(run.id, "pause");
        await s.runtime.control(run.id, "resume");
        await s.runtime.execute(run.id);
        assert.equal(s.adapter.actions.length, 2);
      }
    } finally {
      await s.runtime.close();
    }
  }
});

test("a FALSE return predicate blocks completion even when the root objective is already true", async () => {
  const s = setup();
  s.adapter.verified = false;
  try {
    const run = await s.run();
    assert.equal(s.adapter.result, s.task.expected.result);
    assert.equal(run.status, "blocked");
    assert.match(run.error!, /Subskill effect/);
    assert.equal(s.adapter.actions.length, 2);
  } finally {
    await s.runtime.close();
  }
});

test("expired FALSE return predicates and monitors require reconciliation after child input", async () => {
  for (const source of ["verify", "monitor"]) {
    const s = setup();
    s.adapter.verified = source !== "verify";
    if (source === "monitor") s.parent.machine.states[0].monitor = ["allowed"];
    s.parent.machine.states[0].onError = "repair";
    s.parent.machine.states.push({
      id: "repair",
      monitor: [],
      steps: [
        {
          id: "repair",
          operation: "click",
          scope: "edit",
          args: { locator: "repair" },
        },
      ],
    });
    const observe = s.adapter.observe.bind(s.adapter);
    s.adapter.observe = async () => {
      const observation = await observe();
      if (
        String(s.store.run(s.task.id).bindings.programNode).endsWith("/return")
      ) {
        observation.at = Date.now() - 2500;
        if (source === "monitor") observation.facts.allowed = false;
      }
      return observation;
    };
    try {
      const run = await s.run();
      assert.equal(run.status, "reconciliation_required");
      assert.equal(s.adapter.actions.length, 2);
      assert.equal(
        s.store.events(0, run.id).filter((event) => event.type === "recovery")
          .length,
        0,
      );
      await s.runtime.control(run.id, "pause");
      await s.runtime.control(run.id, "resume");
      await s.runtime.execute(run.id);
      assert.equal(s.adapter.actions.length, 2);
    } finally {
      await s.runtime.close();
    }
  }
});

test("a FALSE return expiring during verification journaling cannot authorize caller recovery", async () => {
  const s = setup();
  s.adapter.verified = false;
  s.parent.machine.states[0].onError = "repair";
  s.parent.machine.states.push({
    id: "repair",
    monitor: [],
    steps: [
      {
        id: "repair",
        operation: "click",
        scope: "edit",
        args: { locator: "repair" },
      },
    ],
  });
  const observe = s.adapter.observe.bind(s.adapter);
  let returningAt = 0;
  s.adapter.observe = async () => {
    const observation = await observe();
    if (
      String(s.store.run(s.task.id).bindings.programNode).endsWith("/return")
    ) {
      observation.at = Date.now() - 1950;
      returningAt = observation.at;
    }
    return observation;
  };
  const append = s.store.append.bind(s.store);
  let assessedAt = 0;
  s.store.append = (...args) => {
    if (args[1] === "subskill_verification") {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      assessedAt = Date.now();
    }
    return append(...args);
  };
  try {
    const run = await s.run();
    assert.ok(assessedAt - returningAt > 2000);
    assert.equal(run.status, "reconciliation_required");
    assert.equal(s.adapter.actions.length, 2);
    assert.equal(
      s.store.events(0, run.id).filter((event) => event.type === "recovery")
        .length,
      0,
    );
  } finally {
    s.store.append = append;
    await s.runtime.close();
  }
});

test("an ordinary FALSE effect expiring during journaling cannot authorize inherited recovery", async () => {
  const s = setup();
  s.adapter.verified = false;
  s.child.machine.states[0].steps[0].verify = "callVerified";
  s.parent.machine.states[0].onError = "repair";
  s.parent.machine.states.push({
    id: "repair",
    monitor: [],
    steps: [
      {
        id: "repair",
        operation: "click",
        scope: "edit",
        args: { locator: "repair" },
      },
    ],
  });
  const observe = s.adapter.observe.bind(s.adapter);
  let afterAt = 0;
  s.adapter.observe = async () => {
    const observation = await observe();
    if (s.adapter.actions.length === 1) {
      observation.at = Date.now() - 1950;
      afterAt = observation.at;
    }
    return observation;
  };
  const append = s.store.append.bind(s.store);
  let assessedAt = 0;
  s.store.append = (...args) => {
    if (args[1] === "experience") {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      assessedAt = Date.now();
    }
    return append(...args);
  };
  try {
    const run = await s.run();
    assert.ok(assessedAt - afterAt > 2000);
    assert.equal(run.status, "reconciliation_required");
    assert.equal(s.adapter.actions.length, 1);
    assert.equal(
      s.store.events(0, run.id).filter((event) => event.type === "recovery")
        .length,
      0,
    );
  } finally {
    s.store.append = append;
    await s.runtime.close();
  }
});

test("caller recovery can repair the entry guard without entering the child early", async () => {
  const s = setup();
  s.adapter.allowed = false;
  s.parent.machine.states[0].onError = "enable";
  s.parent.machine.states.push({
    id: "enable",
    monitor: [],
    next: "call",
    steps: [
      {
        id: "enable",
        operation: "click",
        scope: "edit",
        args: { locator: "enable" },
      },
    ],
  });
  try {
    const run = await s.run();
    assert.equal(run.status, "succeeded", run.error || "Unexpected run state");
    assert.equal(s.adapter.actions[0].args.locator, "enable");
    assert.equal(s.adapter.fills, 1);
    assert.equal(run.bindings.recoveryAttempts, 1);
  } finally {
    await s.runtime.close();
  }
});

test("child step limits cap input independently of a larger root budget", async () => {
  const s = setup();
  s.child.budgets.steps = 1;
  try {
    const run = await s.run();
    assert.equal(run.status, "blocked");
    assert.match(run.error!, /Child step budget/);
    assert.equal(s.adapter.fills, 1);
    assert.equal(s.adapter.clicks, 0);
  } finally {
    await s.runtime.close();
  }
});

test("the root task limit still caps a child with a larger local budget", async () => {
  const s = setup();
  s.task.budgets.steps = 1;
  try {
    const run = await s.run();
    assert.equal(run.status, "blocked");
    assert.match(run.error!, /Step budget/);
    assert.equal(s.adapter.actions.length, 1);
  } finally {
    await s.runtime.close();
  }
});

test("child precondition observations spend the child's step budget", async () => {
  const s = setup();
  s.child.preconditions = ["ready"];
  try {
    const run = await s.run();
    assert.equal(run.status, "blocked");
    assert.deepEqual(
      s.adapter.actions.map((action) => action.operation),
      ["observe", "fill"],
    );
  } finally {
    await s.runtime.close();
  }
});

test("child retries require local allowance and consume persisted local steps", async () => {
  for (const retries of [0, 1]) {
    const s = setup();
    s.parent.recovery.push("fresh_observation");
    s.child.recovery.push("fresh_observation");
    s.child.budgets = { retries, steps: 3 };
    s.adapter.rejected = 1;
    try {
      const run = await s.run();
      assert.equal(
        run.status,
        retries ? "succeeded" : "blocked",
        run.error || "Unexpected run state",
      );
      assert.equal(s.adapter.actions.length, retries ? 3 : 1);
      const counters = Object.values(
        run.bindings.invocationBudgets as Record<
          string,
          { steps: number; retries: number }
        >,
      )[0];
      assert.equal(counters.retries, retries);
      assert.equal(counters.steps, retries ? 3 : 1);
    } finally {
      await s.runtime.close();
    }
  }
});

test("a root retry declaration cannot authorize an undeclared child fresh retry", async () => {
  const s = setup();
  s.parent.recovery.push("fresh_observation");
  s.child.budgets.steps = 3;
  s.adapter.rejected = 1;
  try {
    const run = await s.run();
    assert.equal(run.status, "blocked");
    assert.equal(s.adapter.actions.length, 1);
    assert.equal(
      s.store
        .events(0, run.id)
        .filter((event) => event.type === "preflight_recovery").length,
      0,
    );
  } finally {
    await s.runtime.close();
  }
});

test("ambiguous rejection after delivered input never enters caller or child repair", async () => {
  const s = setup();
  s.adapter.rejected = 1;
  s.adapter.proof = undefined;
  s.adapter.deliverBeforeReject = true;
  s.parent.machine.states[0].onError = "repair";
  s.parent.machine.states.push({
    id: "repair",
    monitor: [],
    steps: [
      {
        id: "repeat",
        operation: "fill",
        scope: "edit",
        args: { locator: "name", value: "$name" },
      },
    ],
  });
  try {
    const run = await s.run();
    assert.equal(run.status, "reconciliation_required");
    assert.equal(s.adapter.fills, 1);
    assert.equal(run.bindings.nonDeliveredAttempts, undefined);
    assert.equal(
      s.store.events(0, run.id).filter((event) => event.type === "uncertain")
        .length,
      1,
    );
    assert.equal(
      s.store.events(0, run.id).filter((event) => event.type === "recovery")
        .length,
      0,
    );
    await s.runtime.control(run.id, "pause");
    await s.runtime.control(run.id, "resume");
    await s.runtime.execute(run.id);
    assert.equal(s.adapter.fills, 1);
  } finally {
    await s.runtime.close();
  }
});

test("a new explicit loop invocation resets local counters while global work remains capped", async () => {
  const s = setup();
  s.adapter.repeatOnce = true;
  s.parent.machine.states[0].transitions = [{ guard: "again", target: "call" }];
  s.parent.machine.states[0].next = "done";
  s.parent.machine.states.push({ id: "done", monitor: [], steps: [] });
  try {
    const run = await s.run();
    assert.equal(run.status, "succeeded", run.error || "Unexpected run state");
    assert.equal(s.adapter.fills, 2);
    const counter = Object.values(
      run.bindings.invocationBudgets as Record<
        string,
        { steps: number; invocation: number; active: boolean }
      >,
    )[0];
    assert.equal(counter.invocation, 2);
    assert.equal(counter.steps, 2);
    assert.equal(counter.active, false);
    assert.ok(run.cursor <= s.task.budgets.steps);
  } finally {
    await s.runtime.close();
  }
});

test("child budgets and exact versions survive pause and Store reopening without charging a wait twice", async () => {
  const s = setup();
  s.child.budgets.steps = 3;
  s.child.machine.states[0].steps.unshift({
    id: "wait",
    operation: "wait",
    scope: "edit",
    args: {},
    waitMs: 5000,
  });
  s.runtime.registry.put(seal(s.child));
  s.runtime.registry.put(seal(s.parent));
  s.runtime.submit(s.task, s.task.id);
  const running = s.runtime.execute(s.task.id);
  const end = Date.now() + 3000;
  while (!s.store.run(s.task.id).wakeAt && Date.now() < end) await delay(10);
  assert.ok(s.store.run(s.task.id).wakeAt);
  await s.runtime.control(s.task.id, "pause");
  await running;
  const previous = s.store.run(s.task.id);
  const childHash = (previous.bindings.skillVersions as Record<string, string>)[
    s.child.id
  ];
  const changed: SkillCapsule = structuredClone(s.child);
  changed.machine.states[0].steps[1].args.value = "wrong new version";
  s.runtime.registry.put(seal(changed));
  await s.runtime.close();
  const reopened = new Store(s.store.root),
    runtime = new Runtime(reopened, s.adapter);
  try {
    const paused = reopened.run(s.task.id);
    paused.wakeAt = Date.now() - 1;
    reopened.putRun(paused);
    await runtime.control(paused.id, "resume");
    await runtime.execute(paused.id);
    const run = reopened.run(paused.id);
    assert.equal(run.status, "succeeded", run.error || "Unexpected run state");
    assert.equal(s.adapter.result, "Bound Cedar");
    assert.equal(
      (run.bindings.skillVersions as Record<string, string>)[s.child.id],
      childHash,
    );
    const counter = Object.values(
      run.bindings.invocationBudgets as Record<
        string,
        { steps: number; invocation: number }
      >,
    )[0];
    assert.equal(counter.steps, 3);
    assert.equal(counter.invocation, 1);
  } finally {
    await runtime.close();
  }
});

test("a failed return observation after child input requires reconciliation without caller recovery", async () => {
  const s = setup();
  s.parent.machine.states[0].onError = "repair";
  s.parent.machine.states.push({
    id: "repair",
    monitor: [],
    steps: [
      {
        id: "repair",
        operation: "fill",
        scope: "edit",
        args: { locator: "name", value: "$name" },
      },
    ],
  });
  const observe = s.adapter.observe.bind(s.adapter);
  let completeObservations = 0;
  s.adapter.observe = async () => {
    if (s.adapter.actions.length === 2 && ++completeObservations === 2)
      throw new Error("Return capture unavailable");
    return observe();
  };
  try {
    const run = await s.run();
    assert.equal(run.status, "reconciliation_required");
    assert.equal(s.adapter.actions.length, 2);
    assert.equal(
      s.store.events(0, run.id).filter((event) => event.type === "recovery")
        .length,
      0,
    );
    assert.equal(
      s.store.events(0, run.id).filter((event) => event.type === "uncertain")
        .length,
      1,
    );
  } finally {
    await s.runtime.close();
  }
});

test("an ancestor child budget caps nested descendant work", async () => {
  const s = setup();
  const leaf = seal(s.child);
  const middle = structuredClone(s.parent);
  middle.id = "middle.form";
  middle.budgets = { steps: 1, retries: 1 };
  middle.dependencies = [leaf.id];
  middle.machine.states[0].steps[0].subskill = leaf.id;
  s.parent.dependencies = [middle.id];
  s.parent.machine.states[0].steps[0].subskill = middle.id;
  try {
    s.runtime.registry.put(leaf);
    s.runtime.registry.put(seal(middle));
    s.runtime.registry.put(seal(s.parent));
    s.runtime.submit(s.task, s.task.id);
    await s.runtime.execute(s.task.id);
    const run = s.store.run(s.task.id);
    assert.equal(run.status, "blocked");
    assert.match(run.error!, /Child step budget/);
    assert.equal(s.adapter.fills, 1);
    assert.equal(s.adapter.clicks, 0);
    const counters = Object.values(
      run.bindings.invocationBudgets as Record<string, { steps: number }>,
    );
    assert.deepEqual(
      counters.map((value) => value.steps),
      [1, 1],
    );
  } finally {
    await s.runtime.close();
  }
});

test("child error handlers obey both child and root retry limits", async () => {
  for (const [childRetries, rootRetries] of [
    [0, 2],
    [1, 2],
    [2, 0],
  ]) {
    const s = setup();
    s.child.budgets = { steps: 4, retries: childRetries };
    s.parent.budgets.retries = rootRetries;
    s.child.machine.states[0].onError = "repair";
    s.child.machine.states.push({
      id: "repair",
      monitor: [],
      steps: [
        {
          id: "fill",
          operation: "fill",
          scope: "edit",
          args: { locator: "name", value: "$name" },
        },
        {
          id: "click",
          operation: "click",
          scope: "edit",
          args: { locator: "apply" },
        },
      ],
    });
    s.adapter.rejected = 1;
    try {
      const run = await s.run();
      const recoverable = childRetries > 0 && rootRetries > 0;
      assert.equal(
        run.status,
        recoverable ? "succeeded" : "blocked",
        run.error || "Unexpected run state",
      );
      assert.equal(s.adapter.actions.length, recoverable ? 3 : 1);
      assert.equal(
        s.store.events(0, run.id).filter((event) => event.type === "recovery")
          .length,
        recoverable ? 1 : 0,
      );
      const counter = Object.values(
        run.bindings.invocationBudgets as Record<string, { retries: number }>,
      )[0];
      assert.equal(counter.retries, recoverable ? 1 : 0);
    } finally {
      await s.runtime.close();
    }
  }
});

test("ordinary pre-dispatch error text cannot impersonate delivery uncertainty", async () => {
  const s = setup();
  s.adapter.observe = async () => {
    throw new Error("Uncertain wording from an unavailable capture");
  };
  try {
    const run = await s.run();
    assert.equal(run.status, "blocked");
    assert.equal(s.adapter.actions.length, 0);
    assert.equal(
      s.store.events(0, run.id).filter((event) => event.type === "uncertain")
        .length,
      0,
    );
  } finally {
    await s.runtime.close();
  }
});

test("uncertainty journal failure cannot authorize child recovery or resume", async () => {
  const s = setup();
  s.adapter.rejected = 1;
  s.adapter.proof = undefined;
  s.adapter.deliverBeforeReject = true;
  s.parent.machine.states[0].onError = "repair";
  s.parent.machine.states.push({
    id: "repair",
    monitor: [],
    steps: [
      {
        id: "repeat",
        operation: "fill",
        scope: "edit",
        args: { locator: "name", value: "$name" },
      },
    ],
  });
  const append = s.store.append.bind(s.store);
  s.store.append = (...args) => {
    if (args[1] === "uncertain")
      throw new Error("Injected uncertainty journal failure");
    return append(...args);
  };
  try {
    const run = await s.run();
    assert.equal(run.status, "reconciliation_required");
    assert.equal(s.adapter.fills, 1);
    assert.equal(
      s.store.events(0, run.id).filter((event) => event.type === "recovery")
        .length,
      0,
    );
    await s.runtime.control(run.id, "pause");
    await s.runtime.control(run.id, "resume");
    await s.runtime.execute(run.id);
    assert.equal(s.adapter.fills, 1);
  } finally {
    s.store.append = append;
    await s.runtime.close();
  }
});
