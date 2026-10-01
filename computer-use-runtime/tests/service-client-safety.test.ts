import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readServiceToken } from "../src/service/lifecycle.js";
import { Store } from "../src/storage/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { service } from "../src/service/index.js";
import { checkSkill, Registry, seal, seedForm } from "../src/skills/index.js";
import { RuntimeClient } from "../src/sdk/index.js";
import { canonical, hash } from "../src/util/canonical.js";
import { previewSkillMigration } from "../src/skills/bundle.js";

test("custom stores never inherit sibling legacy service tokens", () => {
  const root = join(mkdtempSync(join(tmpdir(), "cur-token-scope-")), "custom");
  mkdirSync(root);
  writeFileSync(resolve(root, "../service.token"), "a".repeat(64));
  const config = {
    root,
    port: 4321,
    url: "http://127.0.0.1:4321",
    tokenPath: join(root, "service.token"),
    metadataPath: join(root, "service.json"),
  };
  assert.throws(() => readServiceToken(config), /No local token/);
  writeFileSync(config.tokenPath, "b".repeat(64));
  assert.equal(readServiceToken(config), "b".repeat(64));
});

test("default store retains legacy compatibility and prefers its own token", () => {
  const cwd = process.cwd(),
    temp = mkdtempSync(join(tmpdir(), "cur-default-token-"));
  try {
    process.chdir(temp);
    const root = resolve(".data/service");
    mkdirSync(root, { recursive: true });
    writeFileSync(resolve(".data/service.token"), "c".repeat(64));
    const config = {
      root,
      port: 4321,
      url: "http://127.0.0.1:4321",
      tokenPath: join(root, "service.token"),
      metadataPath: join(root, "service.json"),
    };
    assert.equal(readServiceToken(config), "c".repeat(64));
    writeFileSync(config.tokenPath, "d".repeat(64));
    assert.equal(readServiceToken(config), "d".repeat(64));
    writeFileSync(config.tokenPath, "invalid");
    assert.throws(() => readServiceToken(config), /token file is invalid/);
  } finally {
    process.chdir(cwd);
  }
});

test(
  "encoded imported skill Test reaches the candidate route without shutdown",
  { timeout: 15000 },
  async () => {
    const store = new Store(mkdtempSync(join(tmpdir(), "cur-opaque-skill-")));
    const adapter = new BrowserAdapter(store);
    const runtime = new Runtime(store, adapter);
    const app = await service(runtime);
    let tests = 0;
    runtime.testCandidate = async () => {
      tests++;
      throw new Error("Candidate route reached");
    };
    try {
      await app.listen({ port: 0, host: "127.0.0.1" });
      const client = new RuntimeClient(app.listeningOrigin, store.token());
      for (const id of [".", ".."]) {
        await assert.rejects(
          client.request(
            "/api/skills/import",
            "POST",
            seal({ ...seedForm(), id }),
          ),
          /dot segment/,
        );
        assert.equal(store.get("skills", id), undefined);
        assert.equal((await client.request("/api/service")).status, "running");
      }
      for (const id of [
        "../service/shutdown?",
        "capsule/with?#fragment",
        "opaque Ω",
      ]) {
        const imported = await client.request(
          "/api/skills/import",
          "POST",
          seal({ ...seedForm(), id }),
        );
        assert.equal(imported.status, "quarantined");
        await assert.rejects(
          client.request(
            `/api/skills/${encodeURIComponent(id)}/test`,
            "POST",
            {},
          ),
          /Candidate route reached/,
        );
        assert.equal((await client.request("/api/service")).status, "running");
      }
      assert.equal(tests, 3);
      assert.equal(store.runs().length, 0);
    } finally {
      await app.close();
      await runtime.close();
    }
  },
);

test("skill admission rejects exact URL dot segments before raw, migration or bundle writes", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-dot-admission-")));
  const registry = new Registry(store);
  const snapshot = () =>
    canonical({
      skills: store.list("skills"),
      versions: store.list("skill-versions"),
      migrations: store.list("skill-migrations"),
      origins: store.list("skill-import-origins"),
      receipts: store.list("skill-import-receipts"),
      artifacts: readdirSync(join(store.root, "artifacts")).sort(),
    });
  try {
    const valid = previewSkillMigration(
      Buffer.from(canonical(seedForm())),
      { from: 1, to: 2 },
      registry,
    );
    const before = snapshot();
    for (const id of [".", ".."]) {
      const skill = seal({ ...seedForm(), id });
      const source = Buffer.from(canonical(skill));
      const body = {
        ...valid,
        capsule: skill,
        root: { id, hash: skill.hash },
        origin: {
          ...valid.origin,
          sha256: hash(source),
          originalBase64: source.toString("base64"),
        },
      };
      const { digest: _, ...unsigned } = body;
      const bundle = Buffer.from(
        JSON.stringify({ ...unsigned, digest: hash(canonical(unsigned)) }),
      );
      for (const attempt of [
        () => checkSkill(skill),
        () => registry.put(skill),
        () => registry.import(skill),
        () => registry.migrate(source),
        () => registry.importBundle(bundle),
      ]) {
        assert.throws(attempt, /dot segment/);
        assert.equal(snapshot(), before);
      }
    }
    for (const id of [
      "...",
      ".capsule",
      "capsule.",
      "%2e",
      "../service/shutdown?",
      "opaque Ω",
    ])
      assert.equal(checkSkill(seal({ ...seedForm(), id })).id, id);
  } finally {
    store.close();
  }
});
