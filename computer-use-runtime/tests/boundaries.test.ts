import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Store } from "../src/storage/index.js";
import { Registry, seedForm, seal } from "../src/skills/index.js";
import {
  OllamaProvider,
  LocalEndpointProvider,
} from "../src/providers/index.js";
import { LocalVisionAssessor } from "../src/providers/vision.js";
import { BridgeAdapter } from "../src/adapters/bridge.js";
import type { Action } from "../src/contracts/index.js";

test("publication rejects invented evidence and imports cannot replace an installed skill", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-publish-")));
  try {
    const registry = new Registry(store);
    const skill = seal({ ...seedForm(), status: "draft" });
    registry.put(skill);
    assert.throws(
      () =>
        registry.publish(skill.id, ["invented-1", "invented-2", "invented-3"]),
      /evidence|run|found/i,
    );
    assert.throws(() => registry.import(skill), /already|exists|collision/i);
    assert.equal(registry.get(skill.id).hash, skill.hash);
  } finally {
    store.close();
  }
});

test("local providers reject credentials, unsupported protocols and remote discovery", async () => {
  for (const endpoint of [
    "ftp://localhost",
    "http://user:secret@localhost",
    "https://example.com",
  ]) {
    assert.throws(() => new OllamaProvider("model", endpoint));
    assert.throws(() => new LocalEndpointProvider(endpoint, "model"));
    assert.throws(() => new LocalVisionAssessor("model", endpoint));
    const result = (await OllamaProvider.discover(endpoint)) as any;
    assert.equal(result.available, false);
  }
});

test("local providers never follow redirects carrying prompts or images", async () => {
  let redirected = 0;
  const server = createServer((req, res) => {
    if (req.url === "/leak") {
      redirected++;
      res.end(JSON.stringify({ message: { content: "{}" } }));
    } else {
      res.writeHead(307, { location: "/leak" });
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    await assert.rejects(() =>
      new OllamaProvider("model", `http://127.0.0.1:${address.port}`).generate(
        "private",
        {},
      ),
    );
    await assert.rejects(() =>
      new LocalEndpointProvider(
        `http://127.0.0.1:${address.port}`,
        "model",
      ).generate("private", {}),
    );
    assert.equal(redirected, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

test("bridge rejects receipts for another action and invalid lease generations", async () => {
  const a: Action = {
    schemaVersion: 1,
    id: "action",
    runId: "run",
    requester: "user",
    host: "h",
    session: "s",
    target: "t",
    observationId: "o",
    revision: "r",
    frame: { x: 0, y: 0, width: 100, height: 100, scale: 1 },
    operation: "click",
    args: {},
    deadline: Date.now() + 1000,
    scope: "edit",
    generation: 1,
  };
  const bridge = new BridgeAdapter("h", "s", "t", ["click"], async () => ({
    schemaVersion: 1,
    actionId: "other",
    runId: "run",
    phase: "acknowledged",
    backend: "test",
    at: Date.now(),
    timings: {},
    detail: "test",
  }));
  await assert.rejects(() => bridge.execute(a), /receipt|action/i);
  await assert.rejects(() => bridge.acquire("run"), /generation|lease/i);
});
