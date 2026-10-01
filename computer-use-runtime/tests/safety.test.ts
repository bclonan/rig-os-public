import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Policy, Lease } from "../src/runtime/policy.js";
import { fact, guardPass } from "../src/predicates/index.js";
import { seedForm, seal } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import {
  validate,
  type Action,
  type Observation,
} from "../src/contracts/index.js";
import { BridgeAdapter } from "../src/adapters/bridge.js";
import { compileDemonstrations } from "../src/compiler/experience.js";
const observation = (): Observation => ({
  schemaVersion: 1,
  id: "obs",
  host: "h",
  session: "s",
  target: "t",
  at: Date.now(),
  revision: "r",
  frame: { x: 0, y: 0, width: 100, height: 100, scale: 1 },
  focused: true,
  facts: { ready: true },
  features: [],
  backend: "unit",
});
test("policy rejects scope expansion, wrong host, stale target, frame, focus, deadline and malicious operations", () => {
  const o = observation(),
    task = structuredTask(
      "edit",
      { host: "h", session: "s", identity: "t" },
      { name: "a" },
    ),
    a: Action = {
      schemaVersion: 1,
      id: "a",
      runId: task.id,
      requester: task.requester,
      host: "h",
      session: "s",
      target: "t",
      observationId: "obs",
      revision: "r",
      frame: o.frame,
      operation: "fill",
      args: {},
      deadline: Date.now() + 1000,
      scope: "edit",
      generation: 1,
    };
  const policy = new Policy();
  policy.authorize(task, a, o);
  for (const patch of [
    { host: "other" },
    { session: "other" },
    { target: "other" },
    { scope: "send" },
    { observationId: "old" },
    { revision: "old" },
    { operation: "shell" },
    { deadline: 0 },
    { frame: { ...o.frame, x: 99 } },
    { requester: "attacker" },
  ])
    assert.throws(() => policy.authorize(task, { ...a, ...patch }, o));
  assert.throws(() => policy.authorize(task, a, { ...o, focused: false }));
  assert.throws(() =>
    policy.authorize(task, a, { ...o, at: Date.now() - 3000 }),
  );
});
test("UNKNOWN and expired predicates cannot pass a guard", () => {
  const o = observation();
  assert.equal(guardPass(fact(o, "missing"), o), false);
  assert.equal(guardPass({ ...fact(o, "ready"), expiresAt: 0 }, o), false);
  assert.equal(guardPass(fact(o, "ready"), o), true);
});
test("leases exclude competing clients and revoke stale generations after takeover", () => {
  const lease = new Lease();
  const g = lease.acquire("a");
  assert.throws(() => lease.acquire("b"));
  lease.takeover();
  assert.throws(() => lease.check({ runId: "a", generation: g } as Action));
  assert.throws(() => lease.acquire("a"));
  lease.returnControl();
  assert.ok(lease.acquire("b") > g);
});
test("schema rejects unexpected keys and unsupported schema versions", () => {
  const task = structuredTask(
    "edit",
    { host: "h", session: "s", identity: "t" },
    { name: "a" },
  );
  assert.throws(() =>
    validate("TaskContract", { ...task, shell: "malicious" }),
  );
  assert.throws(() => validate("TaskContract", { ...task, schemaVersion: 2 }));
});
test("durable request deduplication rejects conflicting bodies and second coordinators", () => {
  const path = mkdtempSync(join(tmpdir(), "cur-store-"));
  const s = new Store(path);
  try {
    assert.throws(() => new Store(path));
    s.remember("x", { a: 1 }, "r");
    assert.equal(s.dedup("x", { a: 1 }), "r");
    assert.throws(() => s.dedup("x", { a: 2 }));
  } finally {
    s.close();
  }
  const reopened = new Store(path);
  assert.equal(reopened.dedup("x", { a: 1 }), "r");
  reopened.close();
});
test("imports remain quarantined; invalid hash and executable source are rejected", () => {
  const s = new Store(mkdtempSync(join(tmpdir(), "cur-registry-")));
  const rt = new Runtime(s, {} as any);
  try {
    const imported = rt.registry.import(seedForm());
    assert.equal(imported.status, "quarantined");
    assert.throws(() =>
      rt.registry.import({ ...seedForm(), description: "altered" }),
    );
    const bad = seedForm();
    bad.machine.states[0].steps[0].operation = "eval";
    assert.throws(() => rt.registry.import(seal(bad)));
    assert.throws(() => rt.registry.publish(imported.id, []));
  } finally {
    s.close();
  }
});
test("failed demonstrations are not usable positive labels", () => {
  assert.throws(() =>
    compileDemonstrations([
      { verified: false } as any,
      { verified: false } as any,
      { verified: false } as any,
    ]),
  );
});
test("headless core has no host, service, console or provider imports", () => {
  for (const dir of ["src/runtime", "src/contracts", "src/predicates"])
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts")) continue;
      const text = readFileSync(join(dir, file), "utf8");
      assert.doesNotMatch(
        text,
        /from ['"].*(?:lense|agent-os|service|console|providers|adapters)/i,
      );
    }
});
test("bridge rejects host switching and uses explicit injected mapping", async () => {
  const o = observation();
  const b = new BridgeAdapter("h", "s", "t", [], async (method) =>
    method === "capture" ? o : { generation: 1 },
  );
  assert.equal((await b.observe()).host, "h");
  const bad = new BridgeAdapter("x", "s", "t", [], async () => o);
  await assert.rejects(() => bad.observe());
});
test("ambiguous delivery and failed after capture do not repeat input; restart reconciles", async () => {
  const path = mkdtempSync(join(tmpdir(), "cur-failure-"));
  const store = new Store(path);
  const adapter = await new BrowserAdapter(store).start();
  const rt = new Runtime(store, adapter);
  rt.registry.put(seedForm());
  const task = structuredTask(
    "edit",
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    { name: "Delivered once" },
  );
  let dispatches = 0;
  const realExecute = adapter.execute.bind(adapter);
  adapter.execute = async (a, s) => {
    dispatches++;
    const result = await realExecute(a, s);
    if (dispatches === 1) {
      adapter.observe = async () => {
        throw new Error("Capture disconnected");
      };
    }
    return result;
  };
  try {
    rt.submit(task, task.id);
    await rt.execute(task.id);
    assert.equal(store.run(task.id).status, "reconciliation_required");
    await rt.execute(task.id);
    assert.equal(dispatches, 1);
    assert.equal(
      await adapter.page.locator("#name").inputValue(),
      "Delivered once",
    );
  } finally {
    await rt.close();
  }
  const reopened = new Store(path);
  assert.equal(reopened.run(task.id).status, "reconciliation_required");
  reopened.close();
});
test("live adapter rejects moved layout and wrong host before dispatch", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-stale-")));
  const a = await new BrowserAdapter(store).start();
  try {
    const o = await a.observe(),
      g = await a.acquire("r");
    const action: Action = {
      schemaVersion: 1,
      id: "a",
      runId: "r",
      requester: "local-user",
      host: a.host,
      session: a.session,
      target: a.identity,
      observationId: o.id,
      revision: o.revision,
      frame: o.frame,
      operation: "click",
      args: { locator: "apply" },
      deadline: Date.now() + 1000,
      scope: "edit",
      generation: g,
    };
    await a.page
      .locator("main")
      .evaluate((el) => ((el as HTMLElement).style.marginLeft = "150px"));
    await assert.rejects(() => a.execute(action));
    await assert.rejects(() => a.execute({ ...action, host: "wrong" }));
  } finally {
    await a.close();
    store.close();
  }
});
test("pause and cancel interrupt a durable wait without foreground input", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-pause-")));
  const a = await new BrowserAdapter(store).start();
  const rt = new Runtime(store, a);
  const s = seedForm();
  s.machine.states[0].steps.unshift({
    id: "wait",
    operation: "wait",
    args: {},
    scope: "edit",
    waitMs: 5000,
  });
  rt.registry.put(seal(s));
  const t = structuredTask(
    "edit",
    { host: a.host, session: a.session, identity: a.identity },
    { name: "Later" },
  );
  try {
    rt.submit(t, t.id);
    void rt.execute(t.id);
    const deadline = Date.now() + 5000;
    while (!store.run(t.id).wakeAt && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(
      store.run(t.id).wakeAt,
      "The durable timer must persist before this test pauses it",
    );
    await rt.control(t.id, "pause");
    assert.equal(store.run(t.id).status, "paused");
    assert.ok(store.run(t.id).wakeAt);
    await rt.control(t.id, "cancel");
    assert.equal(store.run(t.id).status, "cancelled");
    assert.equal(await a.page.locator("#name").inputValue(), "");
  } finally {
    await rt.close();
  }
});
