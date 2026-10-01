import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/storage/index.js";
import { ModelRegistry } from "../src/learner/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { seedForm, seal } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { Recorder } from "../src/recorder/index.js";
import { exportDataset, importDataset } from "../src/recorder/bundle.js";
test("model promotion binds audited model bytes and supports rollback", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-model-")));
  try {
    const registry = new ModelRegistry(store);
    registry.register("valid", "models/17/trained.onnx", 17);
    assert.equal(registry.activate("valid").status, "active");
    assert.equal(registry.rollback().active, "fixed");
    assert.equal(
      registry.list().find((m) => m.id === "valid")?.status,
      "retired",
    );
    registry.register("untested", "models/17/initialized.onnx", 17);
    assert.throws(() => registry.activate("untested"), /not tested/);
    const file = join(store.root, "changed.onnx");
    writeFileSync(file, readFileSync("models/17/trained.onnx"));
    registry.register("changed", file, 17);
    writeFileSync(file, "changed");
    assert.throws(() => registry.activate("changed"), /hash changed/);
  } finally {
    store.close();
  }
});
test("portable image dataset round trip preserves hashes and quarantines imported labels", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-export-"))),
    adapter = await new BrowserAdapter(store).start(),
    runtime = new Runtime(store, adapter),
    destination = new Store(mkdtempSync(join(tmpdir(), "cur-import-")));
  try {
    runtime.registry.put(seedForm());
    const task = structuredTask(
      "Set fixture name",
      {
        host: adapter.host,
        session: adapter.session,
        identity: adapter.identity,
      },
      { name: "Export Cedar" },
    );
    runtime.submit(task, task.id);
    await runtime.execute(task.id);
    assert.equal(store.run(task.id).status, "succeeded");
    const recorder = new Recorder(store);
    const recorded = recorder.capture(task.id);
    assert.throws(
      () => recorder.correct(recorded.id, 0, "verified", "test"),
      /positive labels require independent execution evidence/,
    );
    // This controlled fixture explicitly tests private, exact-byte dataset portability.
    const bundle = exportDataset(store, { unredacted: true }),
      receipt = importDataset(destination, bundle);
    assert.equal(receipt.imported, 1);
    assert.equal(destination.list<any>("demonstrations")[0].verified, false);
    for (const id of Object.keys(bundle.artifacts))
      assert.deepEqual(destination.artifactRead(id), store.artifactRead(id));
    const corrupt = structuredClone(bundle);
    corrupt.artifacts[Object.keys(corrupt.artifacts)[0]] = "AAAA";
    assert.throws(() => importDataset(destination, corrupt), /digest/);
    assert.throws(
      () => importDataset(destination, { ...bundle, schemaVersion: 99 }),
      /schema/,
    );
    const corrected = recorder.correct(recorded.id, 0, "unknown", "test");
    assert.equal(corrected.verified, false);
    assert.equal(corrected.steps[0].label, "unknown");
    assert.equal(store.get<any>("demonstrations", recorded.id).verified, false);
  } finally {
    destination.close();
    await runtime.close();
  }
});
test("unpublished dependencies, false completion and missing preconditions are rejected", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-guards-"))),
    adapter = await new BrowserAdapter(store).start(),
    runtime = new Runtime(store, adapter);
  try {
    const base = seedForm();
    runtime.registry.put(base);
    await adapter.reset("closed");
    const task = structuredTask(
      "Must not type behind a closed editor",
      {
        host: adapter.host,
        session: adapter.session,
        identity: adapter.identity,
      },
      { name: "No dispatch" },
    );
    runtime.submit(task, task.id);
    await runtime.execute(task.id);
    assert.equal(store.run(task.id).status, "blocked");
    assert.equal(
      store.events(0, task.id).filter((e) => e.type === "dispatched").length,
      0,
    );
    await adapter.reset();
    const unknown = seal({
      ...base,
      id: "unknown",
      preconditions: ["missing-evidence"],
    });
    runtime.registry.put(unknown);
    const t = structuredTask(
      "Unknown never passes",
      task.target,
      { name: "No" },
      "unknown",
    );
    runtime.submit(t, t.id);
    await runtime.execute(t.id);
    assert.equal(store.run(t.id).status, "blocked");
  } finally {
    await runtime.close();
  }
});
