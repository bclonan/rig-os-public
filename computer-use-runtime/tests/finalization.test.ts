import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../src/storage/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { DesktopRouter } from "../src/adapters/desktop.js";
import { Runtime } from "../src/runtime/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { seedForm } from "../src/skills/index.js";
import { drawingSkill } from "../src/compiler/drawing.js";
import { canonical } from "../src/util/canonical.js";
import type { EnvironmentAdapter } from "../src/contracts/ports.js";
import type {
  Action,
  Observation,
  Receipt,
  TaskContract,
} from "../src/contracts/index.js";
import type { DesktopPlanner } from "../src/assistant/planner.js";
import { reviewDesktop, type Proposal } from "../src/assistant/runner.js";
import { service } from "../src/service/index.js";

class CleanupAdapter implements EnvironmentAdapter {
  host = "owned-host";
  session = "owned-session";
  identity = "browser-fixture-v1";
  capabilities = ["fill", "click", "observe"];
  calls: string[] = [];
  value = "";
  result = "";
  releaseFailure?: Error;
  returnFailure?: Error;
  executeHook?: (action: Action, signal?: AbortSignal) => Promise<void>;
  releaseHook?: (id: string) => Promise<void>;
  async prepare(task: TaskContract) {
    this.calls.push("prepare");
    this.host = task.target.host;
    this.session = task.target.session;
    this.identity = task.target.identity;
  }
  async observe(): Promise<Observation> {
    this.calls.push("observe");
    return {
      schemaVersion: 1,
      id: randomUUID(),
      host: this.host,
      session: this.session,
      target: this.identity,
      at: Date.now(),
      revision: this.value + ":" + this.result,
      frame: { x: 0, y: 0, width: 400, height: 300, scale: 1 },
      focused: true,
      facts: {
        focused: true,
        ready: true,
        closed: false,
        dialog: false,
        name: this.value,
        result: this.result,
      },
      image: "owned-lifecycle-test",
      features: [],
      backend: "lifecycle-test-double",
      controls: [
        {
          index: 0,
          id: "editor",
          name: "Document",
          value: this.value,
          actions: ["fill"],
          controlType: 50004,
          focused: true,
          offscreen: false,
          bounds: { x: 1, y: 1, width: 390, height: 290 },
        },
      ],
    };
  }
  async acquire() {
    this.calls.push("acquire");
    return 1;
  }
  async execute(action: Action, signal?: AbortSignal): Promise<Receipt> {
    this.calls.push("execute");
    if (action.operation === "fill") this.value = String(action.args.value);
    if (action.operation === "click") this.result = this.value;
    await this.executeHook?.(action, signal);
    return {
      schemaVersion: 1,
      actionId: action.id,
      runId: action.runId,
      backend: "lifecycle-test-double",
      at: Date.now(),
      phase: "acknowledged",
      detail: "Owned test effect recorded",
      timings: {},
    };
  }
  async release(id: string) {
    this.calls.push("release:" + id);
    await this.releaseHook?.(id);
    if (this.releaseFailure) throw this.releaseFailure;
  }
  async takeover() {
    this.calls.push("takeover");
  }
  async returnControl() {
    this.calls.push("return");
    if (this.returnFailure) throw this.returnFailure;
  }
  async close() {
    this.calls.push("close");
  }
}

function taskFor(
  adapter: EnvironmentAdapter,
  name = "Cleanup Maple",
  method = "form.seed",
) {
  const task = structuredTask(
    "Write scoped text",
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    { name },
    method,
  );
  if (method === "desktop.assistant") task.expected = {};
  return task;
}

const questionPlanner: DesktopPlanner = {
  next: async () => ({
    kind: "question",
    summary: "Review the document before proceeding",
    question: "What text should be written?",
  }),
};

function temporaryStore() {
  return new Store(mkdtempSync(join(tmpdir(), "cur-cleanup-boundary-")));
}

test("verified application output cannot succeed before held-input cleanup settles", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-finalization-")));
  const adapter = await new BrowserAdapter(store).start();
  const runtime = new Runtime(store, adapter);
  const release = adapter.release.bind(adapter);
  let fail = true;
  adapter.release = async (id) => {
    if (fail) throw new Error("Injected key-up delivery failure");
    return release(id);
  };
  try {
    runtime.registry.put(seedForm());
    const task = structuredTask(
      "Write independently verified output",
      {
        host: adapter.host,
        session: adapter.session,
        identity: adapter.identity,
      },
      { name: "Cleanup Cedar" },
    );
    runtime.submit(task, task.id);
    await runtime.execute(task.id);
    assert.equal((await adapter.observe()).facts.result, "Cleanup Cedar");
    assert.equal(store.run(task.id).status, "reconciliation_required");
    assert.equal(store.run(task.id).bindings.cleanupFailed, true);
    assert.equal(
      store.events(0, task.id).some((event) => event.type === "completed"),
      false,
    );
    const delivered = store
      .events(0, task.id)
      .filter((event) => event.type === "dispatched").length;
    await runtime.execute(task.id);
    assert.equal(
      store.events(0, task.id).filter((event) => event.type === "dispatched")
        .length,
      delivered,
    );
    await assert.rejects(() => runtime.control(task.id, "reconcile"), /key-up/);
    assert.equal(store.run(task.id).status, "reconciliation_required");
    fail = false;
    await runtime.control(task.id, "reconcile");
    assert.equal(store.run(task.id).status, "succeeded");
    assert.equal(
      store.events(0, task.id).filter((event) => event.type === "dispatched")
        .length,
      delivered,
    );
  } finally {
    fail = false;
    await runtime.close();
  }
});

test("same-session cleanup quarantine blocks another target before preparation but permits unrelated host or session", async () => {
  const store = temporaryStore(),
    adapter = new CleanupAdapter();
  const runtime = new Runtime(
    store,
    adapter,
    undefined,
    undefined,
    undefined,
    questionPlanner,
  );
  try {
    const failed = taskFor(adapter, "", "desktop.assistant");
    runtime.submit(failed, failed.id);
    adapter.releaseFailure = new Error("Desktop key-up failed");
    await runtime.execute(failed.id);
    assert.equal(store.run(failed.id).status, "reconciliation_required");
    assert.equal(store.run(failed.id).bindings.cleanupFailed, true);
    assert.ok(
      store
        .events(0, failed.id)
        .some((event) => event.type === "cleanup_failed"),
    );
    adapter.releaseFailure = undefined;
    const blocked = taskFor(adapter, "", "desktop.assistant");
    blocked.target.identity = "other-owned-window";
    const before = adapter.calls.length;
    runtime.submit(blocked, blocked.id);
    await runtime.execute(blocked.id);
    assert.deepEqual(adapter.calls.slice(before), []);
    assert.equal(store.run(blocked.id).status, "blocked");
    assert.match(store.run(blocked.id).error!, /Manually inspect/);
    for (const field of ["host", "session"] as const) {
      const unrelated = taskFor(adapter, "", "desktop.assistant");
      unrelated.target[field] = "unrelated-" + field;
      runtime.submit(unrelated, unrelated.id);
      await runtime.execute(unrelated.id);
      assert.equal(store.run(unrelated.id).status, "awaiting_input");
    }
    await runtime.control(failed.id, "reconcile");
    assert.equal(store.run(failed.id).bindings.cleanupFailed, undefined);
    assert.equal(store.run(failed.id).status, "awaiting_input");
  } finally {
    adapter.releaseFailure = undefined;
    await runtime.close();
  }
});

test("reopened real browser store requires explicit Return before old-run reconciliation or new input", async () => {
  const store = temporaryStore(),
    root = store.root;
  const adapter = await new BrowserAdapter(store).start();
  const runtime = new Runtime(store, adapter);
  const cleanupError = new Error("Lost browser cleanup acknowledgement");
  runtime.registry.put(seedForm());
  const original = taskFor(adapter, "Previously verified Birch");
  adapter.release = async () => {
    throw cleanupError;
  };
  runtime.submit(original, original.id);
  await runtime.execute(original.id);
  assert.equal(
    await adapter.page.locator("#result").textContent(),
    "Previously verified Birch",
  );
  const dispatched = store
    .events(0, original.id)
    .filter((event) => event.type === "dispatched").length;
  await assert.rejects(runtime.close(), (error) => error === cleanupError);
  const reopened = new Store(root),
    fresh = await new BrowserAdapter(reopened).start();
  const recovered = new Runtime(reopened, fresh);
  const counters = {
    prepare: 0,
    acquire: 0,
    observe: 0,
    release: 0,
    execute: 0,
  };
  Object.assign(fresh, {
    prepare: async () => {
      counters.prepare++;
    },
  });
  for (const operation of [
    "acquire",
    "observe",
    "release",
    "execute",
  ] as const) {
    const originalMethod = fresh[operation].bind(fresh);
    // Count real adapter calls without changing their behavior.
    Object.assign(fresh, {
      [operation]: (...args: never[]) => {
        counters[operation]++;
        return Reflect.apply(originalMethod, fresh, args);
      },
    });
  }
  try {
    assert.equal(
      reopened.run(original.id).bindings.cleanupRequiresReturn,
      true,
    );
    await fresh.page.locator("#name").fill("Previously verified Birch");
    await fresh.page.locator("[data-control=apply]").click();
    await assert.rejects(
      () => recovered.control(original.id, "reconcile"),
      /Return control/,
    );
    assert.deepEqual(counters, {
      prepare: 0,
      acquire: 0,
      observe: 0,
      release: 0,
      execute: 0,
    });
    const blocked = taskFor(fresh, "Must not be written");
    recovered.submit(blocked, blocked.id);
    await recovered.execute(blocked.id);
    assert.equal(reopened.run(blocked.id).status, "blocked");
    assert.deepEqual(counters, {
      prepare: 0,
      acquire: 0,
      observe: 0,
      release: 0,
      execute: 0,
    });
    const beforeReturn = reopened.run(original.id);
    const realReturn = fresh.returnControl.bind(fresh);
    fresh.returnControl = async () => {
      throw new Error("Explicit Return failed");
    };
    await assert.rejects(
      () => recovered.returnControl(),
      /Explicit Return failed/,
    );
    assert.equal(reopened.run(original.id).bindings.cleanupFailed, true);
    assert.equal(
      reopened.run(original.id).bindings.cleanupRequiresReturn,
      true,
    );
    fresh.returnControl = realReturn;
    await recovered.returnControl();
    const acknowledged = reopened.run(original.id);
    assert.equal(acknowledged.status, beforeReturn.status);
    assert.equal(acknowledged.cursor, beforeReturn.cursor);
    assert.equal(acknowledged.bindings.cleanupFailed, undefined);
    assert.equal(acknowledged.bindings.cleanupRequiresReturn, undefined);
    assert.ok(
      reopened
        .events(0, original.id)
        .some((event) => event.type === "human_return_acknowledged"),
    );
    assert.equal(counters.execute, 0);
    await recovered.control(original.id, "reconcile");
    assert.equal(reopened.run(original.id).status, "succeeded");
    assert.equal(
      reopened
        .events(0, original.id)
        .filter((event) => event.type === "dispatched").length,
      dispatched,
    );
    const separate = taskFor(fresh, "Separately requested Willow");
    recovered.submit(separate, separate.id);
    await recovered.execute(separate.id);
    assert.equal(reopened.run(separate.id).status, "succeeded");
    assert.equal(
      await fresh.page.locator("#result").textContent(),
      "Separately requested Willow",
    );
  } finally {
    await recovered.close();
  }
});

test("recovery quarantines interrupted ownership without replay and leaves ordinary paused or uncertain tasks unquarantined", async () => {
  const store = temporaryStore(),
    root = store.root,
    adapter = new CleanupAdapter();
  const runtime = new Runtime(store, adapter);
  const interrupted: string[] = [];
  const unaffected: string[] = [];
  for (const status of [
    "running",
    "waiting",
    "verifying_cleanup",
    "paused",
    "succeeded",
    "awaiting_input",
    "reconciliation_required",
  ] as const) {
    const task = taskFor(adapter);
    const run = runtime.submit(task, task.id);
    run.status = status;
    run.cursor = 2;
    run.bindings.proposal = { id: "preserved-proposal" };
    store.putRun(run);
    (["running", "waiting", "verifying_cleanup"].includes(status)
      ? interrupted
      : unaffected
    ).push(task.id);
  }
  await runtime.close();
  const reopened = new Store(root),
    fresh = new CleanupAdapter();
  const recovered = new Runtime(
    reopened,
    fresh,
    undefined,
    undefined,
    undefined,
    questionPlanner,
  );
  try {
    const beforeRecovery = taskFor(fresh, "", "desktop.assistant");
    recovered.submit(beforeRecovery, beforeRecovery.id);
    await recovered.execute(beforeRecovery.id);
    assert.equal(reopened.run(beforeRecovery.id).status, "blocked");
    assert.deepEqual(fresh.calls, []);
    await recovered.recover();
    for (const id of interrupted) {
      assert.equal(reopened.run(id).status, "reconciliation_required");
      assert.equal(reopened.run(id).bindings.cleanupRequiresReturn, true);
      assert.equal(reopened.run(id).bindings.cleanupFailed, true);
      await assert.rejects(
        () => recovered.control(id, "reconcile"),
        /Return control/,
      );
    }
    for (const id of unaffected)
      assert.equal(reopened.run(id).bindings.cleanupFailed, undefined);
    const blocked = taskFor(fresh, "", "desktop.assistant");
    recovered.submit(blocked, blocked.id);
    await recovered.execute(blocked.id);
    assert.deepEqual(fresh.calls, []);
    assert.equal(reopened.run(blocked.id).status, "blocked");
    await recovered.returnControl();
    for (const id of interrupted) {
      const run = reopened.run(id);
      assert.equal(run.status, "reconciliation_required");
      assert.equal(run.cursor, 2);
      assert.deepEqual(run.bindings.proposal, { id: "preserved-proposal" });
      assert.equal(run.bindings.cleanupFailed, undefined);
    }
    assert.deepEqual(fresh.calls, ["return"]);
    const separate = taskFor(fresh, "", "desktop.assistant");
    recovered.submit(separate, separate.id);
    await recovered.execute(separate.id);
    assert.equal(reopened.run(separate.id).status, "awaiting_input");
  } finally {
    await recovered.close();
  }
});

test("explicit Return clears only acknowledged host/session scopes and retains historical failure evidence", async () => {
  const store = temporaryStore(),
    adapter = new CleanupAdapter();
  const runtime = new Runtime(store, adapter);
  const failed: string[] = [];
  for (const target of [
    { host: adapter.host, session: adapter.session },
    { host: "unrelated-host", session: adapter.session },
    { host: adapter.host, session: "unrelated-session" },
  ]) {
    const task = taskFor(adapter);
    task.target = { ...task.target, ...target };
    runtime.submit(task, task.id);
    runtime.recordCleanupFailure(
      task.id,
      new Error("Retain the failure journal"),
    );
    failed.push(task.id);
  }
  try {
    await runtime.returnControl();
    assert.equal(store.run(failed[0]).bindings.cleanupFailed, undefined);
    for (const id of failed.slice(1)) {
      assert.equal(store.run(id).bindings.cleanupFailed, true);
      assert.equal(
        store
          .events(0, id)
          .some((event) => event.type === "human_return_acknowledged"),
        false,
      );
    }
    for (const id of failed)
      assert.ok(
        store.events(0, id).some((event) => event.type === "cleanup_failed"),
      );
    // Trusted aggregate adapters may explicitly acknowledge their additional owned scopes.
    Object.assign(adapter, {
      cleanupScopes: () => failed.map((id) => store.run(id).contract.target),
    });
    adapter.returnFailure = new Error("One owned scope failed cleanup");
    await assert.rejects(() => runtime.returnControl(), /One owned scope/);
    for (const id of failed.slice(1))
      assert.equal(store.run(id).bindings.cleanupFailed, true);
    adapter.returnFailure = undefined;
    await runtime.returnControl();
    for (const id of failed)
      assert.equal(store.run(id).bindings.cleanupFailed, undefined);
  } finally {
    adapter.returnFailure = undefined;
    await runtime.close();
  }
});

test("DesktopRouter reports and acknowledges its owned browser and native scopes while active on browser", async () => {
  const store = temporaryStore(),
    router = new DesktopRouter(store);
  const native = new CleanupAdapter();
  // This test exercises routing without starting a native worker or sending input.
  Object.assign(router, { native });
  const originalBrowserReturn = router.browser.returnControl.bind(
    router.browser,
  );
  let browserReturns = 0;
  router.browser.returnControl = async () => {
    browserReturns++;
    await originalBrowserReturn();
  };
  const runtime = new Runtime(store, router);
  const browserTask = taskFor(router),
    nativeTask = taskFor(native);
  const unknownTask = taskFor(native);
  unknownTask.target.session = "unowned-session";
  for (const task of [browserTask, nativeTask, unknownTask]) {
    const run = runtime.submit(task, task.id);
    run.status = "reconciliation_required";
    run.bindings.cleanupFailed = true;
    store.putRun(run);
  }
  try {
    assert.deepEqual(router.cleanupScopes(), [
      { host: router.browser.host, session: router.browser.session },
      { host: native.host, session: native.session },
    ]);
    await runtime.returnControl();
    assert.equal(browserReturns, 1);
    assert.deepEqual(native.calls, ["return"]);
    assert.equal(store.run(browserTask.id).bindings.cleanupFailed, undefined);
    assert.equal(store.run(nativeTask.id).bindings.cleanupFailed, undefined);
    assert.equal(store.run(unknownTask.id).bindings.cleanupFailed, true);
    assert.equal(router.session, router.browser.session);
  } finally {
    await runtime.close();
  }
});

test("service shutdown reaches onClose and releases the lock after an active cleanup failure", async () => {
  const store = temporaryStore(),
    root = store.root,
    adapter = new CleanupAdapter();
  const runtime = new Runtime(store, adapter);
  runtime.registry.put(seedForm());
  const app = await service(runtime);
  const task = taskFor(adapter);
  const cleanupError = new Error("Service drain lost key-up acknowledgement");
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  adapter.executeHook = async (_action, signal) => {
    markEntered();
    await new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  adapter.releaseFailure = cleanupError;
  runtime.submit(task, task.id);
  const active = runtime.execute(task.id);
  try {
    await Promise.race([
      entered,
      delay(5000).then(() => {
        throw new Error("Service action never entered");
      }),
    ]);
    await assert.rejects(app.close(), (error) => error === cleanupError);
    await active;
    assert.equal(adapter.calls.at(-1), "close");
    const reopened = new Store(root);
    try {
      assert.equal(reopened.run(task.id).bindings.cleanupFailed, true);
    } finally {
      reopened.close();
    }
  } finally {
    adapter.releaseFailure = undefined;
    await app.close().catch(() => {});
  }
});

test("uncertain delivery with successful input cleanup does not quarantine other tasks", async () => {
  const store = temporaryStore(),
    adapter = new CleanupAdapter();
  const runtime = new Runtime(store, adapter);
  runtime.registry.put(seedForm());
  try {
    adapter.executeHook = async () => {
      throw new Error("Worker disconnected after input");
    };
    const uncertain = taskFor(adapter);
    runtime.submit(uncertain, uncertain.id);
    await runtime.execute(uncertain.id);
    assert.equal(store.run(uncertain.id).status, "reconciliation_required");
    assert.equal(store.run(uncertain.id).bindings.cleanupFailed, undefined);
    adapter.executeHook = undefined;
    const separate = taskFor(adapter, "New explicit Alder");
    runtime.submit(separate, separate.id);
    await runtime.execute(separate.id);
    assert.equal(store.run(separate.id).status, "succeeded");
  } finally {
    await runtime.close();
  }
});

test("worker loss during reviewed desktop dispatch persists cleanup quarantine and never repeats the action", async () => {
  const store = temporaryStore(),
    adapter = new CleanupAdapter();
  const planner: DesktopPlanner = {
    next: async () => ({
      kind: "action",
      summary: "Write one scoped value",
      operation: "fill",
      control: 0,
      text: "Once only",
    }),
  };
  const runtime = new Runtime(
    store,
    adapter,
    undefined,
    undefined,
    undefined,
    planner,
  );
  try {
    const task = taskFor(adapter, "", "desktop.assistant");
    runtime.submit(task, task.id);
    await runtime.execute(task.id);
    const proposal = store.run(task.id).bindings.proposal as Proposal;
    adapter.releaseFailure = new Error(
      "Worker lost before key-up confirmation",
    );
    adapter.executeHook = async () => {
      throw new Error("Worker lost after actual test effect");
    };
    await reviewDesktop(runtime, task.id, {
      command: "approve",
      proposalId: proposal.id,
    });
    await runtime.execute(task.id);
    assert.equal(adapter.value, "Once only");
    assert.equal(adapter.calls.filter((call) => call === "execute").length, 1);
    assert.equal(store.run(task.id).bindings.cleanupFailed, true);
    assert.ok(
      store.events(0, task.id).some((event) => event.type === "uncertain"),
    );
    await runtime.execute(task.id);
    const separate = taskFor(adapter, "", "desktop.assistant");
    separate.target.identity = "another-window";
    const count = adapter.calls.length;
    runtime.submit(separate, separate.id);
    await runtime.execute(separate.id);
    assert.equal(adapter.calls.length, count);
    adapter.releaseFailure = undefined;
    await runtime.returnControl();
  } finally {
    adapter.releaseFailure = undefined;
    await runtime.close();
  }
});

test("close drains all owned work after cleanup failure, closes adapter and releases the Store lock", async () => {
  const store = temporaryStore(),
    root = store.root,
    adapter = new CleanupAdapter();
  const runtime = new Runtime(store, adapter);
  runtime.registry.put(seedForm());
  const first = taskFor(adapter),
    second = taskFor(adapter);
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const originalError = new Error("Original key-up failure during shutdown");
  adapter.executeHook = async (_action, signal) => {
    markEntered();
    await new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  adapter.releaseHook = async (id) => {
    if (id === first.id) throw originalError;
    await delay(80);
    store.put("test", "second-control-drained", true);
  };
  runtime.submit(first, first.id);
  runtime.submit(second, second.id);
  const active = runtime.execute(first.id);
  await Promise.race([
    entered,
    delay(5000).then(() => {
      throw new Error("Dispatch never entered");
    }),
  ]);
  const queued = runtime.execute(second.id);
  const unhandled: unknown[] = [];
  const capture = (error: unknown) => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", capture);
  try {
    await assert.rejects(runtime.close(), (error) => error === originalError);
    await Promise.all([active, queued]);
    assert.equal(adapter.calls.at(-1), "close");
    assert.equal(adapter.calls.filter((call) => call === "execute").length, 1);
    const reopened = new Store(root);
    try {
      assert.equal(reopened.get("test", "second-control-drained"), true);
      assert.equal(reopened.run(first.id).bindings.cleanupFailed, true);
      assert.equal(reopened.run(second.id).status, "paused");
    } finally {
      reopened.close();
    }
    await delay(0);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", capture);
  }
});

test("emergency takeover still reaches the adapter after pause cleanup fails and retains quarantine", async () => {
  const store = temporaryStore(),
    adapter = new CleanupAdapter();
  const runtime = new Runtime(store, adapter);
  const task = taskFor(adapter);
  const cleanupError = new Error("Takeover pause cleanup failed");
  runtime.submit(task, task.id);
  adapter.releaseFailure = cleanupError;
  try {
    await assert.rejects(
      () => runtime.takeover(),
      (error) => error === cleanupError,
    );
    assert.deepEqual(adapter.calls, ["release:" + task.id, "takeover"]);
    assert.equal(store.run(task.id).bindings.cleanupFailed, true);
    const separate = taskFor(adapter);
    runtime.submit(separate, separate.id);
    await runtime.execute(separate.id);
    assert.equal(adapter.calls.filter((call) => call === "execute").length, 0);
    adapter.releaseFailure = undefined;
    await runtime.returnControl();
  } finally {
    adapter.releaseFailure = undefined;
    await runtime.close();
  }
});

test("authenticated Return acknowledges cleanup only after success", async () => {
  const store = temporaryStore(),
    root = store.root,
    adapter = new CleanupAdapter();
  const runtime = new Runtime(store, adapter);
  const task = taskFor(adapter);
  runtime.submit(task, task.id);
  const run = store.run(task.id);
  run.status = "reconciliation_required";
  run.bindings.cleanupFailed = true;
  run.bindings.cleanupRequiresReturn = true;
  run.bindings.proposal = { id: "keep-review" };
  store.putRun(run);
  const app = await service(runtime);
  const headers = {
    authorization: "Bearer " + store.token(),
    "idempotency-key": randomUUID(),
    "x-correlation-id": randomUUID(),
  };
  try {
    adapter.returnFailure = new Error("Return acknowledgement unavailable");
    const failedReturn = await app.inject({
      method: "POST",
      url: "/api/return",
      headers,
      payload: {},
    });
    assert.equal(failedReturn.statusCode, 400);
    assert.match(
      failedReturn.json().error,
      /Return acknowledgement unavailable/,
    );
    assert.equal(store.run(task.id).bindings.cleanupFailed, true);
    adapter.returnFailure = undefined;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/return",
          headers,
          payload: {},
        })
      ).statusCode,
      200,
    );
    assert.equal(store.run(task.id).status, "reconciliation_required");
    assert.deepEqual(store.run(task.id).bindings.proposal, {
      id: "keep-review",
    });
    assert.equal(store.run(task.id).bindings.cleanupFailed, undefined);
    assert.equal(adapter.calls.filter((call) => call === "execute").length, 0);
  } finally {
    await app.close();
  }
  const reopened = new Store(root);
  reopened.close();
});

test("cleanup journal rollback retains the known local barrier until Return acknowledgement commits", async () => {
  const store = temporaryStore(),
    adapter = new CleanupAdapter();
  const runtime = new Runtime(
    store,
    adapter,
    undefined,
    undefined,
    undefined,
    questionPlanner,
  );
  const originalAppend = store.append.bind(store);
  const originalPutRun = store.putRun.bind(store);
  const cleanupError = new Error("Known held input cleanup failure");
  const journalError = new Error("Cleanup journal transaction failed");
  const failed = taskFor(adapter, "", "desktop.assistant");
  runtime.submit(failed, failed.id);
  let failJournal = true;
  store.append = (...args) => {
    if (failJournal && args[1] === "cleanup_failed") throw journalError;
    return originalAppend(...args);
  };
  store.putRun = (run) => {
    if (failJournal && run.bindings.cleanupFailed === true) throw journalError;
    return originalPutRun(run);
  };
  adapter.releaseFailure = cleanupError;
  try {
    await runtime.execute(failed.id);
    assert.equal(store.run(failed.id).bindings.cleanupFailed, undefined);
    failJournal = false;
    store.putRun = originalPutRun;
    adapter.releaseFailure = undefined;
    const blocked = taskFor(adapter, "", "desktop.assistant");
    blocked.target.identity = "another-window";
    const before = adapter.calls.length;
    runtime.submit(blocked, blocked.id);
    await runtime.execute(blocked.id);
    assert.deepEqual(adapter.calls.slice(before), []);
    assert.equal(store.run(blocked.id).status, "blocked");
    store.append = (...args) => {
      if (args[1] === "human_return_acknowledged")
        throw new Error("Return acknowledgement journal failed");
      return originalAppend(...args);
    };
    await assert.rejects(
      () => runtime.returnControl(),
      /Return acknowledgement journal failed/,
    );
    const stillBlocked = taskFor(adapter, "", "desktop.assistant");
    const afterFailedReturn = adapter.calls.length;
    runtime.submit(stillBlocked, stillBlocked.id);
    await runtime.execute(stillBlocked.id);
    assert.equal(adapter.calls.length, afterFailedReturn);
    store.append = originalAppend;
    store.putRun = originalPutRun;
    await runtime.returnControl();
    const acknowledgement = store
      .events(0, failed.id)
      .find((event) => event.type === "human_return_acknowledged");
    assert.ok(acknowledgement);
    assert.match(
      String((acknowledgement.data as { cleanupError: string }).cleanupError),
      /Known held input/,
    );
    const separate = taskFor(adapter, "", "desktop.assistant");
    runtime.submit(separate, separate.id);
    await runtime.execute(separate.id);
    assert.equal(store.run(separate.id).status, "awaiting_input");
  } finally {
    store.append = originalAppend;
    adapter.releaseFailure = undefined;
    await runtime.close();
  }
});

test("a failed cleanup journal still checkpoints quarantine durably before Store reopen", async () => {
  const store = temporaryStore(),
    root = store.root,
    adapter = new CleanupAdapter();
  const runtime = new Runtime(store, adapter);
  runtime.registry.put(seedForm());
  const task = taskFor(adapter);
  runtime.submit(task, task.id);
  const originalAppend = store.append.bind(store);
  const journalError = new Error("Cleanup event cannot be saved");
  const cleanupError = new Error("Durable cleanup confirmation lost");
  store.append = (...args) => {
    if (args[1] === "cleanup_failed") throw journalError;
    return originalAppend(...args);
  };
  adapter.releaseFailure = cleanupError;
  await assert.rejects(
    runtime.execute(task.id),
    (error) => error === journalError,
  );
  assert.equal(store.run(task.id).bindings.cleanupFailed, true);
  assert.equal(
    store.events(0, task.id).some((event) => event.type === "cleanup_failed"),
    false,
  );
  store.append = originalAppend;
  await assert.rejects(runtime.close(), (error) => error === cleanupError);
  const reopened = new Store(root),
    fresh = new CleanupAdapter();
  const recovered = new Runtime(
    reopened,
    fresh,
    undefined,
    undefined,
    undefined,
    questionPlanner,
  );
  try {
    assert.equal(reopened.run(task.id).bindings.cleanupRequiresReturn, true);
    const separate = taskFor(fresh, "", "desktop.assistant");
    recovered.submit(separate, separate.id);
    await recovered.execute(separate.id);
    assert.deepEqual(fresh.calls, []);
    await assert.rejects(
      () => recovered.control(task.id, "reconcile"),
      /Return control/,
    );
    await recovered.returnControl();
  } finally {
    await recovered.close();
  }
});

test("pause and Return cannot make a coordinator-interrupted cursor resumable", async () => {
  const store = temporaryStore(),
    root = store.root,
    oldAdapter = new CleanupAdapter();
  const oldRuntime = new Runtime(store, oldAdapter);
  oldRuntime.registry.put(seedForm());
  const task = taskFor(oldAdapter, "Potentially delivered prior value");
  const original = oldRuntime.submit(task, task.id);
  original.status = "running";
  store.putRun(original);
  // Save the coordinator-death boundary without running graceful shutdown.
  store.close();
  const reopened = new Store(root),
    fresh = new CleanupAdapter();
  const recovered = new Runtime(reopened, fresh);
  try {
    assert.equal(reopened.run(task.id).status, "reconciliation_required");
    await recovered.control(task.id, "pause");
    assert.equal(reopened.run(task.id).status, "reconciliation_required");
    assert.equal(reopened.run(task.id).bindings.cleanupRequiresReturn, true);
    await recovered.returnControl();
    assert.equal(reopened.run(task.id).status, "reconciliation_required");
    const resumed = await recovered.control(task.id, "resume");
    assert.equal(resumed.status, "reconciliation_required");
    await recovered.execute(task.id);
    assert.equal(
      fresh.calls.filter((call) =>
        ["prepare", "acquire", "execute"].includes(call),
      ).length,
      0,
    );
    await recovered.control(task.id, "reconcile");
    assert.equal(reopened.run(task.id).status, "awaiting_input");
    assert.equal(fresh.calls.filter((call) => call === "execute").length, 0);
    const separate = taskFor(fresh, "New separately requested value");
    recovered.submit(separate, separate.id);
    await recovered.execute(separate.id);
    assert.equal(reopened.run(separate.id).status, "succeeded");
    assert.equal(fresh.calls.filter((call) => call === "execute").length, 2);
  } finally {
    await recovered.close();
  }
});

test("drawing reconciliation retains subject review after normal cleanup or a recovered release failure", async () => {
  for (const failCleanup of [false, true]) {
    const store = temporaryStore(),
      adapter = new CleanupAdapter();
    const runtime = new Runtime(store, adapter);
    adapter.capabilities.push("drag");
    const observe = adapter.observe.bind(adapter);
    let changed = false;
    adapter.executeHook = async () => {
      changed = true;
    };
    const bounds = canonical({ x: 1, y: 1, width: 390, height: 290 });
    adapter.observe = async () => {
      const observation = await observe();
      observation.facts.canvasBounds = bounds;
      observation.facts.canvasImage = (changed ? "b" : "a").repeat(64);
      return observation;
    };
    const before = await adapter.observe();
    const skill = drawingSkill(
      {
        subject: "Unassessed requested subject",
        strokes: [
          [
            [0.1, 0.1],
            [0.8, 0.1],
          ],
        ],
      },
      adapter.identity,
      { x: 1, y: 1, width: 390, height: 290 },
    );
    runtime.registry.put(skill);
    const task = taskFor(adapter, "", skill.id);
    task.parameters.drawingFrame = canonical(before.frame);
    task.parameters.canvasBounds = bounds;
    task.expected = { canvasChangedFrom: "a".repeat(64), canvasBounds: bounds };
    if (failCleanup)
      adapter.releaseFailure = new Error(
        "Drawing cleanup was not acknowledged",
      );
    try {
      runtime.submit(task, task.id);
      await runtime.execute(task.id);
      assert.equal(
        store.run(task.id).status,
        failCleanup ? "reconciliation_required" : "needs_review",
      );
      const dispatched = adapter.calls.filter(
        (call) => call === "execute",
      ).length;
      assert.equal(dispatched, 1);
      adapter.releaseFailure = undefined;
      await runtime.control(task.id, "reconcile");
      assert.equal(store.run(task.id).status, "needs_review");
      assert.equal(store.run(task.id).bindings.cleanupFailed, undefined);
      assert.equal(
        adapter.calls.filter((call) => call === "execute").length,
        dispatched,
      );
      assert.equal(
        store
          .events(0, task.id)
          .some((event) => event.type === "user_confirmed_completion"),
        false,
      );
    } finally {
      adapter.releaseFailure = undefined;
      await runtime.close();
    }
  }
});
