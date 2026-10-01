import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store, canonical } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { structuredTask } from "../src/compiler/intent.js";
import { seedForm, seal } from "../src/skills/index.js";
import type { Action, Receipt } from "../src/contracts/index.js";

const rejected = (action: Action): Receipt => ({
  schemaVersion: 1,
  actionId: action.id,
  runId: action.runId,
  backend: "controlled-no-dispatch",
  phase: "rejected",
  dispatched: false,
  at: Date.now(),
  detail: "Target content changed before dispatch",
  timings: {},
});

test("explicit state recovery charges a rejected attempt once and fails closed if its journal transaction fails", async () => {
  for (const failPersistence of [false, true]) {
    const s = await setup();
    const transaction = s.store.transaction.bind(s.store);
    const initialResult = await s.adapter.page.locator("#result").textContent();
    const base = seedForm();
    s.skill.preconditions = [];
    s.skill.recovery = ["escalate"];
    s.skill.budgets = { steps: 3, retries: 1 };
    s.skill.machine = {
      initial: "try",
      states: [
        {
          id: "try",
          monitor: [],
          onError: "repair",
          steps: [
            {
              id: "attempt",
              operation: "fill",
              args: { locator: "name", value: "$name" },
              scope: "edit",
            },
          ],
        },
        {
          id: "repair",
          monitor: [],
          steps: base.machine.states.flatMap((state) => state.steps),
        },
      ],
    };
    s.task.budgets.steps = 3;
    let calls = 0;
    const execute = s.adapter.execute.bind(s.adapter);
    s.adapter.execute = async (action, signal) => {
      calls++;
      if (calls === 1) {
        if (failPersistence)
          s.store.transaction = () => {
            throw new Error("Controlled journal failure");
          };
        return rejected(action);
      }
      return execute(action, signal);
    };
    try {
      const run = await s.run();
      assert.equal(calls, failPersistence ? 1 : 3);
      assert.equal(run.status, failPersistence ? "blocked" : "succeeded");
      assert.equal(
        await s.adapter.page.locator("#result").textContent(),
        failPersistence ? initialResult : "Fresh Cedar",
      );
      if (failPersistence)
        assert.match(run.error!, /Could not persist rejected attempt/);
      else {
        assert.equal(run.cursor, 2);
        assert.equal(run.bindings.nonDeliveredAttempts, 1);
        assert.equal(run.bindings.recoveryAttempts, 1);
        assert.equal(
          s.store.events(0, run.id).filter((event) => event.type === "rejected")
            .length,
          1,
        );
      }
    } finally {
      s.store.transaction = transaction;
      await s.runtime.close();
    }
  }
});
async function setup() {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "cur-preflight-recovery-")),
  );
  const adapter = await new BrowserAdapter(store).start();
  const runtime = new Runtime(store, adapter);
  const skill = seedForm();
  skill.recovery.push("fresh_observation");
  skill.budgets.retries = 2;
  const task = structuredTask(
    "Apply a bounded fresh retry",
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    { name: "Fresh Cedar" },
  );
  async function run() {
    runtime.registry.put(seal(skill));
    runtime.submit(task, task.id);
    await runtime.execute(task.id);
    return store.run(task.id);
  }
  return { store, adapter, runtime, skill, task, run };
}

test("exact no-dispatch rejection refreshes the current step without replaying an acknowledged predecessor", async () => {
  const s = await setup();
  const actions: Action[] = [];
  const execute = s.adapter.execute.bind(s.adapter);
  let denied = false;
  s.adapter.execute = async (action, signal) => {
    actions.push(action);
    if (action.operation === "click" && !denied) {
      denied = true;
      await s.adapter.page
        .locator("main")
        .evaluate((node) => ((node as HTMLElement).style.marginLeft = "140px"));
      return rejected(action);
    }
    return execute(action, signal);
  };
  try {
    const run = await s.run();
    assert.equal(run.status, "succeeded", run.error || "");
    assert.equal(
      await s.adapter.page.locator("#result").textContent(),
      "Fresh Cedar",
    );
    assert.equal(
      actions.filter((action) => action.operation === "fill").length,
      1,
    );
    const clicks = actions.filter((action) => action.operation === "click");
    assert.equal(clicks.length, 2);
    assert.notEqual(clicks[0].id, clicks[1].id);
    assert.notEqual(clicks[0].observationId, clicks[1].observationId);
    assert.notEqual(clicks[0].revision, clicks[1].revision);
    assert.deepEqual(clicks[0].args, clicks[1].args);
    assert.equal(run.bindings.nonDeliveredAttempts, 1);
    assert.equal(run.bindings.recoveryAttempts, 1);
    assert.equal(
      s.store.events(0, run.id).filter((event) => event.type === "acknowledged")
        .length,
      2,
    );
    assert.equal(
      s.store.events(0, run.id).some((event) => event.type === "uncertain"),
      false,
    );
  } finally {
    await s.runtime.close();
  }
});

test("safe retries exhaust the declared retry and total step budgets", async () => {
  for (const steps of [8, 1]) {
    const s = await setup();
    s.task.budgets.steps = steps;
    let calls = 0;
    s.adapter.execute = async (action) => {
      calls++;
      return rejected(action);
    };
    try {
      const run = await s.run();
      assert.equal(run.status, "blocked");
      assert.equal(calls, steps === 1 ? 1 : 3);
      assert.equal(run.cursor, 0);
      assert.equal(run.bindings.nonDeliveredAttempts, calls);
      assert.equal(await s.adapter.page.locator("#name").inputValue(), "");
      assert.equal(
        s.store
          .events(0, run.id)
          .some((event) => event.type === "acknowledged"),
        false,
      );
    } finally {
      await s.runtime.close();
    }
  }
});

test("a changed approved drawing frame prevents the fresh retry before redispatch", async () => {
  const s = await setup();
  const initial = await s.adapter.observe();
  s.skill.id = "drawing.recovery-test";
  s.task.method = s.skill.id;
  s.task.parameters.drawingFrame = canonical(initial.frame);
  s.task.parameters.canvasBounds = "approved";
  const observe = s.adapter.observe.bind(s.adapter);
  let changed = false,
    calls = 0;
  s.adapter.observe = async () => {
    const result = await observe();
    return {
      ...result,
      frame: changed ? { ...result.frame, x: 100 } : result.frame,
      facts: { ...result.facts, canvasBounds: "approved" },
    };
  };
  s.adapter.execute = async (action) => {
    calls++;
    changed = true;
    return rejected(action);
  };
  try {
    const run = await s.run();
    assert.equal(run.status, "blocked");
    assert.match(run.error!, /moved or resized/);
    assert.equal(calls, 1);
    assert.equal(await s.adapter.page.locator("#name").inputValue(), "");
  } finally {
    await s.runtime.close();
  }
});

test("delivered unknown input never enters opt-in preflight recovery", async () => {
  const s = await setup();
  const execute = s.adapter.execute.bind(s.adapter);
  let calls = 0;
  s.adapter.execute = async (action, signal) => {
    calls++;
    await execute(action, signal);
    throw new Error("Lost delivery reply after real effect");
  };
  try {
    const run = await s.run();
    assert.equal(run.status, "reconciliation_required");
    await s.runtime.execute(run.id);
    assert.equal(calls, 1);
    assert.equal(
      await s.adapter.page.locator("#name").inputValue(),
      "Fresh Cedar",
    );
    assert.equal(
      s.store
        .events(0, run.id)
        .some((event) => event.type === "preflight_recovery"),
      false,
    );
  } finally {
    await s.runtime.close();
  }
});

test("cancel and takeover between rejection and retry prevent further input", async () => {
  for (const command of ["cancel", "takeover"] as const) {
    const s = await setup();
    let calls = 0,
      stop: Promise<unknown> | undefined;
    s.adapter.execute = async (action) => {
      calls++;
      stop =
        command === "cancel"
          ? s.runtime.control(s.task.id, "cancel")
          : s.runtime.takeover();
      return rejected(action);
    };
    try {
      const run = await s.run();
      await stop;
      assert.equal(run.status, command === "cancel" ? "cancelled" : "paused");
      assert.equal(calls, 1);
      assert.equal(await s.adapter.page.locator("#name").inputValue(), "");
    } finally {
      await s.runtime.close();
    }
  }
});

test("a real process crash after the persisted safe-retry checkpoint remains reconciliation-only", async () => {
  const root = mkdtempSync(join(tmpdir(), "cur-preflight-crash-"));
  const moduleUrl = (name: string) =>
    JSON.stringify(pathToFileURL(resolve("src", name)).href);
  const source = `
    import { Store } from ${moduleUrl("storage/index.ts")};
    import { Runtime } from ${moduleUrl("runtime/index.ts")};
    import { BrowserAdapter } from ${moduleUrl("adapters/browser.ts")};
    import { seedForm, seal } from ${moduleUrl("skills/index.ts")};
    import { structuredTask } from ${moduleUrl("compiler/intent.ts")};
    const store = new Store(process.argv[1]);
    const adapter = await new BrowserAdapter(store).start();
    const runtime = new Runtime(store, adapter);
    const skill = seedForm(); skill.recovery.push('fresh_observation');
    runtime.registry.put(seal(skill));
    const task = structuredTask('Crash before safe retry', {host:adapter.host,session:adapter.session,identity:adapter.identity},{name:'Never delivered'});
    runtime.submit(task, task.id);
    const append = store.append.bind(store);
    store.append = (...args) => { const event=append(...args); if(args[1]==='preflight_recovery') process.exit(82); return event; };
    adapter.execute = async action => ({schemaVersion:1,actionId:action.id,runId:action.runId,backend:'controlled-no-dispatch',phase:'rejected',dispatched:false,at:Date.now(),detail:'Preflight content changed',timings:{}});
    await runtime.execute(task.id);
    process.exit(83);
  `;
  let code: unknown;
  try {
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", source, root],
      { cwd: process.cwd(), timeout: 30000, windowsHide: true },
    );
  } catch (error) {
    code = (error as { code: unknown }).code;
  }
  assert.equal(code, 82);
  const store = new Store(root);
  const adapter = await new BrowserAdapter(store).start();
  const runtime = new Runtime(store, adapter);
  try {
    const interrupted = store.runs()[0];
    assert.equal(interrupted.bindings.nonDeliveredAttempts, 1);
    assert.equal(interrupted.bindings.recoveryAttempts, 1);
    assert.ok(interrupted.bindings.programNode);
    await runtime.recover();
    await runtime.execute(interrupted.id);
    assert.equal(store.run(interrupted.id).status, "reconciliation_required");
    assert.equal(
      store
        .events(0, interrupted.id)
        .filter((event) => event.type === "requested").length,
      1,
    );
    assert.equal(
      store
        .events(0, interrupted.id)
        .some((event) => event.type === "acknowledged"),
      false,
    );
    assert.equal(await adapter.page.locator("#name").inputValue(), "");
  } finally {
    await runtime.close();
  }
});

test("pause charges a rejected attempt before resume and cannot restore an exhausted step budget", async () => {
  for (const optedIn of [true, false]) {
    const s = await setup();
    if (!optedIn) s.skill.recovery = [];
    s.task.budgets.steps = 1;
    let calls = 0,
      paused: Promise<unknown> | undefined;
    const execute = s.adapter.execute.bind(s.adapter);
    s.adapter.execute = async (action, signal) => {
      calls++;
      if (calls === 1) {
        paused = s.runtime.control(s.task.id, "pause");
        return rejected(action);
      }
      return execute(action, signal);
    };
    try {
      await s.run();
      await paused;
      const run = s.store.run(s.task.id);
      assert.equal(run.status, "paused");
      assert.equal(run.bindings.nonDeliveredAttempts, 1);
      assert.equal(run.bindings.recoveryAttempts, undefined);
      await s.runtime.control(s.task.id, "resume");
      await s.runtime.execute(s.task.id);
      assert.equal(s.store.run(s.task.id).status, "blocked");
      assert.match(s.store.run(s.task.id).error!, /Step budget exceeded/);
      assert.equal(calls, 1);
      assert.equal(await s.adapter.page.locator("#name").inputValue(), "");
    } finally {
      await s.runtime.close();
    }
  }
});

test("absent no-dispatch proof blocks automatic retry and contradictory receipts require reconciliation", async () => {
  for (const variant of [
    "absent",
    "rejected-delivered",
    "ack-not-delivered",
    "wrong-action",
  ] as const) {
    const s = await setup();
    let calls = 0;
    s.adapter.execute = async (action) => {
      calls++;
      const receipt = rejected(action) as Receipt & { dispatched?: boolean };
      if (variant === "absent") delete receipt.dispatched;
      if (variant === "rejected-delivered") receipt.dispatched = true;
      if (variant === "ack-not-delivered") receipt.phase = "acknowledged";
      if (variant === "wrong-action") receipt.actionId = "wrong-action-id";
      return receipt;
    };
    try {
      const run = await s.run();
      assert.equal(run.status, "reconciliation_required");
      await s.runtime.execute(run.id);
      assert.equal(calls, 1);
      assert.equal(await s.adapter.page.locator("#name").inputValue(), "");
      assert.equal(
        s.store
          .events(0, run.id)
          .some((event) => event.type === "preflight_recovery"),
        false,
      );
    } finally {
      await s.runtime.close();
    }
  }
});
