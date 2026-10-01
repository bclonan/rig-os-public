import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Store } from "../src/storage/index.js";

test("content-hash ingestion refuses existing corruption without replacing evidence", () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "cur-artifact-integrity-")),
  );
  try {
    const original = Buffer.from("owned immutable evidence");
    const id = store.artifact(original);
    assert.equal(store.artifact(original), id);
    const artifact = join(store.root, "artifacts", id);
    const corrupted = Buffer.from("corrupt existing bytes");
    writeFileSync(artifact, corrupted);
    assert.throws(() => store.artifact(original), /corrupt.*ingestion/i);
    assert.deepEqual(readFileSync(artifact), corrupted);
    assert.throws(() => store.artifactRead(id), /corrupt/i);
    assert.equal(store.events().length, 0);
  } finally {
    store.close();
  }
});

test(
  "concurrent stale-lock recovery permits exactly one coordinator",
  { timeout: 15000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cur-lock-race-"));
    writeFileSync(join(root, "coordinator.lock"), "99999999");
    const source = `import { Store } from ${JSON.stringify(pathToFileURL(resolve("src/storage/index.ts")).href)};
    let store;
    process.on('message', command => {
      if (command === 'go') { try { store = new Store(process.env.TEST_STORE); process.send('acquired'); } catch(e) { process.send(e.name === 'StoreLockedError' ? 'blocked' : String(e)); } }
      if (command === 'close') { store?.close(); process.disconnect(); }
    }); process.send('ready');`;
    const children = Array.from({ length: 4 }, () =>
      spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", source],
        {
          env: { ...process.env, TEST_STORE: root },
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      ),
    );
    const next = (child: (typeof children)[number]) =>
      new Promise<unknown>((resolve, reject) => {
        child.once("message", resolve);
        child.once("error", reject);
      });
    try {
      assert.deepEqual(await Promise.all(children.map(next)), [
        "ready",
        "ready",
        "ready",
        "ready",
      ]);
      const pending = children.map(next);
      children.forEach((child) => child.send("go"));
      const results = await Promise.all(pending);
      assert.equal(
        results.filter((value) => value === "acquired").length,
        1,
        JSON.stringify(results),
      );
      assert.equal(
        results.filter((value) => value === "blocked").length,
        3,
        JSON.stringify(results),
      );
    } finally {
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              child.once("close", () => resolve());
              if (child.connected) child.send("close");
              else child.kill();
            }),
        ),
      );
    }
    const reopened = new Store(root);
    reopened.close();
  },
);

test("failed store transactions leave no partial submission state", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-transaction-")));
  try {
    assert.throws(() =>
      store.transaction(() => {
        store.put("example", "partial", { unsafe: true });
        store.remember("request", { input: 1 }, "run");
        throw new Error("interrupted");
      }),
    );
    assert.equal(store.get("example", "partial"), undefined);
    assert.equal(store.dedup("request", { input: 1 }), undefined);
  } finally {
    store.close();
  }
});
