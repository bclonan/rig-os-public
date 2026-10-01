import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Store } from "../src/storage/index.js";
import { Registry, seal, seedForm } from "../src/skills/index.js";
import { canonical, hash } from "../src/util/canonical.js";
import {
  commitSkillMigration,
  previewSkillMigration,
  validateSkillBundle,
  type SkillBundleV2,
} from "../src/skills/bundle.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { service } from "../src/service/index.js";

function skills() {
  const leaf = seal({ ...seedForm(), id: "portable.leaf" });
  const middle = seal({
    ...seedForm(),
    id: "portable.middle",
    dependencies: [leaf.id],
    machine: {
      initial: "apply",
      states: [
        {
          id: "apply",
          monitor: [],
          steps: [
            {
              id: "leaf",
              operation: "subskill",
              subskill: leaf.id,
              scope: "edit",
              args: { name: "$name" },
            },
          ],
        },
      ],
    },
  });
  const root = seal({
    ...middle,
    id: "portable.root",
    status: "published",
    dependencies: [middle.id],
    version: "1.0.0",
    machine: {
      initial: "apply",
      states: [
        {
          id: "apply",
          monitor: [],
          steps: [
            {
              id: "middle",
              operation: "subskill",
              subskill: middle.id,
              scope: "edit",
              args: { name: "$name" },
            },
          ],
        },
      ],
    },
    budgets: { steps: 20, retries: 0 },
    provenance: {
      kind: "compiled",
      demonstrations: ["foreign-demo"],
      tests: ["foreign-test-1", "foreign-test-2", "foreign-test-3"],
      uncertain: [],
    },
  });
  return { leaf, middle, root };
}
function prepare(store: Store, root = false) {
  const registry = new Registry(store),
    graph = skills();
  registry.put(graph.leaf);
  registry.put(graph.middle);
  if (root) registry.put(graph.root);
  return { registry, ...graph };
}
function snapshot(store: Store) {
  return canonical({
    skills: store.list("skills"),
    migrations: store.list("skill-migrations"),
    origins: store.list("skill-import-origins"),
    receipts: store.list("skill-import-receipts"),
    artifacts: readdirSync(join(store.root, "artifacts")).sort(),
  });
}
function encoded(bundle: SkillBundleV2) {
  return Buffer.from(JSON.stringify(bundle, null, 2));
}
function redigest(bundle: SkillBundleV2) {
  const { digest: _, ...body } = bundle;
  return { ...body, digest: hash(canonical(body)) };
}

test("explicit v1-to-v2 migration preserves exact bytes and durable receipts; malformed routes and bundles never mutate", () => {
  const path = mkdtempSync(join(tmpdir(), "cur-skill-migrate-"));
  let store = new Store(path);
  try {
    const { registry, root, leaf, middle } = prepare(store);
    const source = Buffer.from("\n  " + JSON.stringify(root, null, 2) + "\n");
    const originalState = snapshot(store);
    const preview = previewSkillMigration(source, { from: 1, to: 2 }, registry);
    assert.equal(snapshot(store), originalState);
    assert.deepEqual(preview.dependencies, [
      { id: leaf.id, hash: leaf.hash },
      { id: middle.id, hash: middle.hash },
    ]);
    assert.deepEqual(preview.root, { id: root.id, hash: root.hash });
    assert.deepEqual(
      Buffer.from(preview.origin.originalBase64, "base64"),
      source,
    );
    assert.throws(
      () =>
        commitSkillMigration(
          store,
          source,
          { from: 0, to: 2 } as any,
          registry,
        ),
      /Unsupported/,
    );
    assert.throws(
      () =>
        commitSkillMigration(
          store,
          source,
          { from: 1, to: 3 } as any,
          registry,
        ),
      /Unsupported/,
    );
    assert.throws(
      () =>
        commitSkillMigration(
          store,
          source,
          { from: 1, to: 2, code: "eval" } as any,
          registry,
        ),
      /fields/,
    );
    assert.throws(
      () =>
        commitSkillMigration(
          store,
          Buffer.alloc(1024 * 1024 + 1, 32),
          { from: 1, to: 2 },
          registry,
        ),
      /budget/,
    );
    assert.equal(snapshot(store), originalState);
    const committed = commitSkillMigration(
      store,
      source,
      { from: 1, to: 2 },
      registry,
    );
    assert.deepEqual(
      store.artifactRead(committed.receipt.sourceArtifact as string),
      source,
    );
    assert.deepEqual(
      commitSkillMigration(store, source, { from: 1, to: 2 }, registry).receipt,
      committed.receipt,
    );
    store.put("skill-migrations", committed.bundle.digest, {
      ...committed.receipt,
      at: 0,
    });
    assert.throws(
      () => commitSkillMigration(store, source, { from: 1, to: 2 }, registry),
      /receipt changed/,
    );
    store.put("skill-migrations", committed.bundle.digest, committed.receipt);
    const originalArtifactPath = join(
      store.root,
      "artifacts",
      committed.receipt.sourceArtifact as string,
    );
    writeFileSync(originalArtifactPath, "tampered original bytes");
    assert.throws(
      () => commitSkillMigration(store, source, { from: 1, to: 2 }, registry),
      /Corrupt artifact/,
    );
    writeFileSync(originalArtifactPath, source);
    assert.equal(
      registry.list().some((skill) => skill.id === root.id),
      false,
    );
    const valid = encoded(committed.bundle),
      beforeInvalid = snapshot(store);
    const corruptions = [
      (b: any) => {
        b.schemaVersion = 99;
      },
      (b: any) => {
        b.unrecognized = true;
      },
      (b: any) => {
        b.origin.schemaVersion = 0;
      },
      (b: any) => {
        b.migration.id = "execute-custom-source";
      },
      (b: any) => {
        b.migration.implementationSha256 = "trust-me";
      },
      (b: any) => {
        b.migration.code = "eval";
      },
      (b: any) => {
        b.origin.originalBase64 += "\n";
      },
      (b: any) => {
        b.origin.originalBase64 = Buffer.from("{}").toString("base64");
      },
      (b: any) => {
        b.root.hash = "0".repeat(64);
      },
      (b: any) => {
        b.dependencies = [...b.dependencies, b.dependencies[0]];
      },
      (b: any) => {
        b.dependencies[0].hash = "0".repeat(64);
      },
      (b: any) => {
        b.dependencies[0].extra = "unsafe";
      },
      (b: any) => {
        b.capsule = seal({
          ...b.capsule,
          effects: [...b.capsule.effects, "save"],
        });
      },
    ];
    for (const change of corruptions) {
      const changed: any = structuredClone(committed.bundle);
      change(changed);
      assert.throws(() => registry.importBundle(encoded(redigest(changed))));
      assert.equal(snapshot(store), beforeInvalid);
    }
    assert.throws(
      () =>
        registry.importBundle(
          encoded({ ...committed.bundle, digest: "0".repeat(64) }),
        ),
      /digest/,
    );
    assert.equal(snapshot(store), beforeInvalid);
    store.close();
    store = new Store(path);
    assert.deepEqual(
      store.artifactRead(committed.receipt.sourceArtifact as string),
      source,
    );
    const reopened = new Registry(store).importBundle(valid);
    assert.equal(reopened.candidate.status, "quarantined");
    assert.notEqual(reopened.candidate.hash, root.hash);
    assert.deepEqual(reopened.candidate.provenance, {
      kind: root.provenance.kind,
      demonstrations: [],
      tests: [],
      uncertain: [],
    });
    assert.equal(
      hash(store.artifactRead(reopened.receipt.artifact)),
      reopened.receipt.artifact,
    );
    assert.throws(
      () => new Registry(store).importBundle(valid),
      /already exists/,
    );
    assert.throws(() =>
      new Registry(store).publish(root.id, root.provenance.tests),
    );
  } finally {
    store.close();
  }
});

test("complete dependency closure rejects cycles and missing or changed transitive bindings", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-skill-closure-")));
  try {
    const { registry, root, leaf, middle } = prepare(store);
    const source = Buffer.from(canonical(root));
    const bundle = previewSkillMigration(source, { from: 1, to: 2 }, registry);
    registry.put(
      seal({ ...leaf, description: "Changed transitive dependency" }),
    );
    const before = snapshot(store);
    assert.throws(
      () => registry.importBundle(encoded(bundle)),
      /closure changed/,
    );
    assert.equal(snapshot(store), before);
    registry.put(leaf);
    const cycle = seal({ ...middle, dependencies: [root.id] });
    const cycleRepository = {
      ...registry,
      get: (id: string) => (id === middle.id ? cycle : registry.get(id)),
      list: () => registry.list(),
      put: registry.put.bind(registry),
      version: registry.version.bind(registry),
    };
    assert.throws(
      () => previewSkillMigration(source, { from: 1, to: 2 }, cycleRepository),
      /Cyclic/,
    );
    assert.throws(
      () =>
        previewSkillMigration(
          Buffer.from(canonical(seal({ ...root, dependencies: ["missing"] }))),
          { from: 1, to: 2 },
          registry,
        ),
      /Missing/,
    );
    const foreign = redigest({
      ...bundle,
      migration: { ...bundle.migration, implementationSha256: "0".repeat(64) },
    });
    assert.equal(
      validateSkillBundle(encoded(foreign), registry).migration
        .implementationSha256,
      "0".repeat(64),
    );
    const imported = registry.importBundle(encoded(foreign));
    assert.equal(imported.candidate.status, "quarantined");
    assert.throws(
      () => registry.publish(imported.candidate.id, []),
      /regression evidence/,
    );
    const alreadyQuarantined = seal({
      ...seedForm(),
      id: "portable.already-quarantined",
      status: "quarantined",
      provenance: {
        kind: "hand_authored",
        demonstrations: [],
        tests: [],
        uncertain: [],
      },
    });
    const again = registry.importBundle(
      encoded(
        previewSkillMigration(
          Buffer.from(canonical(alreadyQuarantined)),
          { from: 1, to: 2 },
          registry,
        ),
      ),
    );
    assert.equal(again.candidate.status, "quarantined");
    assert.notEqual(again.candidate.hash, alreadyQuarantined.hash);
  } finally {
    store.close();
  }
});

test("authenticated migration and bundle routes quarantine real browser imports and reject changed closure publication", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-skill-api-")));
  const adapter = await new BrowserAdapter(store).start(),
    runtime = new Runtime(store, adapter);
  const { root, leaf } = prepare(store);
  const app = await service(runtime);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const url = "http://127.0.0.1:" + (app.server.address() as any).port;
  async function post(path: string, body: unknown, authorized = true) {
    return fetch(url + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authorized ? { Authorization: "Bearer " + store.token() } : {}),
        "Idempotency-Key": randomUUID(),
        "X-Correlation-ID": randomUUID(),
      },
      body: JSON.stringify(body),
    });
  }
  try {
    const source = "\n" + JSON.stringify(root, null, 2) + "\n";
    assert.equal(
      (await post("/api/skills/migrate", { source, from: 1, to: 2 }, false))
        .status,
      401,
    );
    const prior = snapshot(store);
    assert.equal(
      (await post("/api/skills/migrate", { source, from: 1, to: 99 })).status,
      400,
    );
    assert.equal(
      (
        await post("/api/skills/migrate", {
          source,
          from: 1,
          to: 2,
          transform: "unsafe",
        })
      ).status,
      400,
    );
    assert.equal(snapshot(store), prior);
    const preview = await post("/api/skills/migrations/preview", {
      source,
      from: 1,
      to: 2,
    });
    assert.equal(preview.status, 200);
    assert.equal(store.list("skill-migrations").length, 0);
    const migratedResponse = await post("/api/skills/migrate", {
      source,
      from: 1,
      to: 2,
    });
    assert.equal(migratedResponse.status, 200);
    const migrated: any = await migratedResponse.json();
    assert.deepEqual(
      store.artifactRead(migrated.receipt.sourceArtifact),
      Buffer.from(source),
    );
    const importedResponse = await post("/api/skills/bundles/import", {
      source: JSON.stringify(migrated.bundle),
    });
    assert.equal(importedResponse.status, 200);
    const imported: any = await importedResponse.json();
    assert.equal(imported.candidate.status, "quarantined");
    assert.equal(imported.candidate.provenance.tests.length, 0);
    const task = structuredTask(
      "Imported package cannot authorize execution",
      {
        host: adapter.host,
        session: adapter.session,
        identity: adapter.identity,
      },
      { name: "Unapproved" },
      root.id,
    );
    runtime.submit(task, task.id);
    await runtime.execute(task.id);
    assert.equal(store.run(task.id).status, "blocked");
    assert.equal(
      store.events(0, task.id).filter((event) => event.type === "requested")
        .length,
      0,
    );
    registryChange();
    const changedTest = await post("/api/skills/" + root.id + "/test", {});
    assert.equal(changedTest.status, 400);
    assert.match(((await changedTest.json()) as any).error, /closure changed/);
    assert.equal(runtime.registry.get(root.id).status, "quarantined");
    assert.ok(
      store
        .runs()
        .filter((run) => run.skill === root.id && run.status === "succeeded")
        .length >= 3,
    );
    runtime.registry.put(leaf);
    const tested = await post("/api/skills/" + root.id + "/test", {});
    assert.equal(tested.status, 200, await tested.clone().text());
    const published: any = await tested.json();
    assert.equal(published.status, "published");
    assert.equal(published.provenance.tests.length, 3);
    assert.ok(
      published.provenance.tests.every(
        (id: string) => !root.provenance.tests.includes(id),
      ),
    );
    assert.equal(
      await adapter.page.locator("#result").textContent(),
      store.run(published.provenance.tests.at(-1)).contract.parameters.name,
    );
    const headers = { Authorization: "Bearer " + store.token() };
    const exported = await fetch(
      url + "/api/skills/" + root.id + "/export?schemaVersion=2",
      { headers },
    );
    assert.equal(exported.status, 200);
    assert.equal(((await exported.json()) as any).schemaVersion, 2);
    assert.equal(
      (
        await fetch(
          url + "/api/skills/" + root.id + "/export?schemaVersion=99",
          { headers },
        )
      ).status,
      400,
    );
    const uncertainSource = seal({
      ...root,
      id: "portable.uncertain",
      status: "draft",
      provenance: {
        ...root.provenance,
        uncertain: [
          "Controlled precondition has not passed held-out negatives",
        ],
      },
    });
    const uncertainBundle = previewSkillMigration(
      Buffer.from(canonical(uncertainSource)),
      { from: 1, to: 2 },
      runtime.registry,
    );
    const uncertainImport = await post("/api/skills/bundles/import", {
      source: JSON.stringify(uncertainBundle),
    });
    assert.equal(uncertainImport.status, 200);
    const uncertainCandidate: any = (await uncertainImport.json()).candidate;
    assert.deepEqual(uncertainCandidate.provenance, {
      ...uncertainSource.provenance,
      demonstrations: [],
      tests: [],
    });
    const beforeRuns = store.runs().length;
    const uncertainTest = await post(
      "/api/skills/" + uncertainSource.id + "/test",
      {},
    );
    assert.equal(uncertainTest.status, 400);
    assert.match(((await uncertainTest.json()) as any).error, /uncertainties/);
    assert.equal(store.runs().length, beforeRuns);
    const positiveRuns: string[] = [];
    for (const name of ["Uncertain Aspen", "Uncertain Elm", "Uncertain Ash"]) {
      const testTask = structuredTask(
        "Measure positive behavior without resolving causal uncertainty",
        {
          host: adapter.host,
          session: adapter.session,
          identity: adapter.identity,
        },
        { name },
        uncertainCandidate.id,
      );
      const run = await runtime.testCandidate(
        testTask,
        uncertainCandidate,
        () => adapter.reset("ready", "base"),
      );
      assert.equal(run.status, "succeeded");
      positiveRuns.push(run.id);
    }
    assert.throws(
      () => runtime.registry.publish(uncertainCandidate.id, positiveRuns),
      /resolved uncertainty/,
    );
    const erased = seal({
      ...uncertainCandidate,
      provenance: { ...uncertainCandidate.provenance, uncertain: [] },
    });
    runtime.registry.put(erased);
    assert.throws(
      () => runtime.registry.publish(erased.id, positiveRuns),
      /candidate changed/,
    );
    const rawUncertain = seal({
      ...uncertainSource,
      id: "portable.uncertain.raw",
    });
    assert.deepEqual(
      runtime.registry.import(rawUncertain).provenance.uncertain,
      rawUncertain.provenance.uncertain,
    );
    function registryChange() {
      runtime.registry.put(
        seal({
          ...leaf,
          description: "Actual changed dependency, same measured form behavior",
        }),
      );
    }
  } finally {
    await app.close();
    await runtime.close();
  }
});

test("public CLI export, explicit migration and import retain original bytes in isolated stores", () => {
  const directory = mkdtempSync(join(tmpdir(), "cur-skill-cli-")),
    sourceRoot = join(directory, "source"),
    targetRoot = join(directory, "target");
  const source = new Store(sourceRoot),
    target = new Store(targetRoot);
  const graph = prepare(source, true);
  prepare(target);
  source.close();
  target.close();
  const raw = join(directory, "raw.json"),
    bundlePath = join(directory, "bundle.json"),
    exportPath = join(directory, "export.json");
  function cli(data: string, ...args: string[]) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", ...args],
      {
        encoding: "utf8",
        env: { ...process.env, CUR_DATA: data },
        windowsHide: true,
        timeout: 20000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  }
  cli(sourceRoot, "export", graph.root.id, raw);
  const exact = readFileSync(raw);
  writeFileSync(
    raw,
    Buffer.concat([Buffer.from("\n  "), exact, Buffer.from("\n")]),
  );
  cli(sourceRoot, "skill-migrate", raw, bundlePath);
  cli(sourceRoot, "bundle-export", graph.root.id, exportPath);
  assert.equal(JSON.parse(readFileSync(exportPath, "utf8")).schemaVersion, 2);
  cli(targetRoot, "bundle-import", bundlePath);
  const reopened = new Store(targetRoot);
  try {
    const imported = new Registry(reopened).get(graph.root.id);
    assert.equal(imported.status, "quarantined");
    assert.notEqual(imported.hash, graph.root.hash);
    const receipt: any = reopened.list("skill-import-receipts")[0];
    assert.deepEqual(
      reopened.artifactRead(receipt.sourceArtifact),
      readFileSync(raw),
    );
    assert.throws(() =>
      new Registry(reopened).publish(
        graph.root.id,
        graph.root.provenance.tests,
      ),
    );
  } finally {
    reopened.close();
  }
});
