import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { seedForm, seal } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { service } from "../src/service/index.js";
import { fact } from "../src/predicates/index.js";

async function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-review-")));
  const adapter = await new BrowserAdapter(store).start();
  const runtime = new Runtime(store, adapter);
  runtime.registry.put(seedForm());
  const task = structuredTask(
    "Write the requested name",
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    { name: "Review Willow" },
  );
  return { store, adapter, runtime, task };
}

test("a repeated submission and direct execute do not resume paused work", async () => {
  const s = await setup();
  const app = await service(s.runtime);
  try {
    s.runtime.submit(s.task, "retry-key");
    await s.runtime.control(s.task.id, "pause");
    const result = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: {
        host: "127.0.0.1",
        authorization: "Bearer " + s.store.token(),
        "idempotency-key": "retry-key",
        "x-correlation-id": "test",
      },
      payload: s.task,
    });
    assert.equal(result.statusCode, 200);
    await s.runtime.execute(s.task.id);
    assert.equal(s.store.run(s.task.id).status, "paused");
    assert.equal(
      s.store.events(0, s.task.id).some((e) => e.type === "dispatched"),
      false,
    );
  } finally {
    await app.close();
  }
});

test("unknown control commands cannot resume paused work", async () => {
  const s = await setup();
  try {
    s.runtime.submit(s.task, s.task.id);
    await s.runtime.control(s.task.id, "pause");
    await assert.rejects(
      () => s.runtime.control(s.task.id, "typo" as never),
      /command/i,
    );
    assert.equal(s.store.run(s.task.id).status, "paused");
  } finally {
    await s.runtime.close();
  }
});

test("a resumed run retains its exact original skill bytes", async () => {
  const s = await setup();
  try {
    const original = seedForm();
    s.runtime.submit(s.task, s.task.id);
    const run = s.store.run(s.task.id);
    run.status = "paused";
    run.bindings.skillHash = original.hash;
    s.store.putRun(run);
    const changed = structuredClone(original);
    changed.machine.states[0].steps[0].args.value = "Unexpected replacement";
    s.runtime.registry.put(seal(changed));
    await s.runtime.control(s.task.id, "resume");
    await s.runtime.execute(s.task.id);
    assert.equal(s.store.run(s.task.id).bindings.skillHash, original.hash);
    assert.equal(
      (await s.adapter.observe()).facts.result,
      s.task.parameters.name,
    );
    assert.equal(s.store.run(s.task.id).status, "succeeded");
  } finally {
    await s.runtime.close();
  }
});

test("late journal uncertainty remains visible to resume checks", async () => {
  const s = await setup();
  try {
    s.runtime.submit(s.task, s.task.id);
    const run = s.store.run(s.task.id);
    run.status = "paused";
    s.store.putRun(run);
    for (let i = 0; i < 5001; i++)
      s.runtime.event(run, "observation", { index: i });
    s.runtime.event(run, "uncertain", {
      actionId: "delivered-without-confirmation",
    });
    assert.ok(s.store.events(0, run.id).some((e) => e.type === "uncertain"));
    await s.runtime.control(run.id, "resume");
    assert.equal(s.store.run(run.id).status, "reconciliation_required");
  } finally {
    await s.runtime.close();
  }
});

test("reconciliation does not turn a semantic assessment into objective success", async () => {
  const s = await setup();
  const runtime = new Runtime(s.store, s.adapter, {
    verify: (_task, o) => [fact(o, "ready", true, "semantic")],
  });
  try {
    runtime.submit(s.task, s.task.id);
    const run = s.store.run(s.task.id);
    run.status = "reconciliation_required";
    s.store.putRun(run);
    await runtime.control(run.id, "reconcile");
    assert.notEqual(s.store.run(run.id).status, "succeeded");
  } finally {
    await runtime.close();
  }
});

test("a leading wait cannot skip required preconditions", async () => {
  const s = await setup();
  try {
    const skill = seedForm();
    skill.preconditions = ["unavailable-proof"];
    skill.machine.states[0].steps.unshift({
      id: "wait",
      operation: "wait",
      args: {},
      scope: "edit",
      waitMs: 1,
    });
    s.runtime.registry.put(seal(skill));
    s.runtime.submit(s.task, s.task.id);
    await s.runtime.execute(s.task.id);
    assert.equal(
      s.store.events(0, s.task.id).some((e) => e.type === "dispatched"),
      false,
    );
    assert.equal(s.store.run(s.task.id).status, "blocked");
  } finally {
    await s.runtime.close();
  }
});

test("a durable wait is interrupted by the run deadline", async () => {
  const s = await setup();
  try {
    const skill = seedForm();
    skill.preconditions = [];
    skill.machine.states = [
      {
        id: "wait",
        steps: [
          {
            id: "wait",
            operation: "wait",
            args: {},
            scope: "edit",
            waitMs: 2500,
          },
        ],
        monitor: [],
      },
    ];
    skill.machine.initial = "wait";
    s.runtime.registry.put(seal(skill));
    s.task.budgets.deadlineMs = 150;
    s.runtime.submit(s.task, s.task.id);
    const started = performance.now();
    await s.runtime.execute(s.task.id);
    assert.ok(
      performance.now() - started < 1500,
      "Deadline must cancel the wait, not wait for its timer to finish",
    );
    assert.equal(s.store.run(s.task.id).status, "blocked");
  } finally {
    await s.runtime.close();
  }
});

test("encoded API routes still authenticate and only loopback Host values are accepted", async () => {
  const s = await setup();
  const app = await service(s.runtime);
  try {
    for (const url of ["/api/tasks", "/%61pi/tasks"]) {
      const result = await app.inject({
        method: "GET",
        url,
        headers: { host: "127.0.0.1" },
      });
      assert.notEqual(result.statusCode, 200, url);
    }
    for (const host of [
      "[evil.example]",
      "[2001:db8::1]",
      "localhost.evil.example",
    ]) {
      const result = await app.inject({
        method: "GET",
        url: "/api/tasks",
        headers: { host, authorization: "Bearer " + s.store.token() },
      });
      assert.equal(result.statusCode, 403, host);
    }
  } finally {
    await app.close();
  }
});

test("nested skill versions remain pinned across a pause", async () => {
  const s = await setup();
  try {
    const child = seedForm();
    const parent = seal({
      ...child,
      id: "composed",
      dependencies: [child.id],
      machine: {
        initial: "child",
        states: [
          {
            id: "child",
            monitor: [],
            steps: [
              {
                id: "child",
                operation: "subskill",
                subskill: child.id,
                args: {},
                scope: "edit",
              },
            ],
          },
        ],
      },
    });
    s.runtime.registry.put(parent);
    s.task.method = parent.id;
    const run = s.runtime.submit(s.task, s.task.id);
    run.status = "paused";
    run.bindings.skillHash = parent.hash;
    run.bindings.skillVersions = {
      [parent.id]: parent.hash,
      [child.id]: child.hash,
    };
    s.store.putRun(run);
    const changed = structuredClone(child);
    changed.machine.states[0].steps[0].args.value = "Different child";
    s.runtime.registry.put(seal(changed));
    await s.runtime.control(run.id, "resume");
    await s.runtime.execute(run.id);
    assert.equal(s.store.run(run.id).status, "succeeded");
    assert.equal(
      (await s.adapter.observe()).facts.result,
      s.task.parameters.name,
    );
    await assert.rejects(() => s.runtime.control(run.id, "cancel"), /finished/);
    assert.equal(s.store.run(run.id).status, "succeeded");
  } finally {
    await s.runtime.close();
  }
});

test("candidate fixture preparation waits for the preceding run", async () => {
  const s = await setup();
  try {
    const waitSkill = seedForm();
    waitSkill.machine.states[0].steps.unshift({
      id: "wait",
      operation: "wait",
      args: {},
      scope: "edit",
      waitMs: 150,
    });
    s.runtime.registry.put(seal(waitSkill));
    s.runtime.submit(s.task, s.task.id);
    const running = s.runtime.execute(s.task.id);
    const candidate = seal({ ...seedForm(), id: "candidate", status: "draft" });
    const task = structuredTask(
      "candidate",
      s.task.target,
      { name: "Candidate" },
      candidate.id,
    );
    let precedingStatus = "";
    const result = await s.runtime.testCandidate(task, candidate, async () => {
      precedingStatus = s.store.run(s.task.id).status;
      await s.adapter.reset();
    });
    await running;
    assert.equal(precedingStatus, "succeeded");
    assert.equal(result.status, "succeeded");
  } finally {
    await s.runtime.close();
  }
});
