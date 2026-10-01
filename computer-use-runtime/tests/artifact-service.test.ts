import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/index.js";
import { DesktopRouter } from "../src/adapters/desktop.js";
import { Runtime } from "../src/runtime/index.js";
import { service } from "../src/service/index.js";
import { RuntimeClient } from "../src/sdk/index.js";
import { seedForm } from "../src/skills/index.js";
import type { ModelProvider } from "../src/contracts/ports.js";

test("authenticated artifact controls, exact download and browser routing share one persistent service", async () => {
  const root = mkdtempSync(join(tmpdir(), "cur-artifact-api-"));
  let calls = 0;
  const provider: ModelProvider = {
    capabilities: {
      schemaVersion: 1,
      id: "scripted-test",
      modalities: ["text"],
      structuredOutput: true,
      tools: false,
      cancellation: true,
      local: true,
      maxTokens: 512,
      available: true,
    },
    async generate() {
      calls++;
      return { rows: [{ label: "ALDER", double: 6 }] };
    },
  };
  const store = new Store(root),
    router = new DesktopRouter(store, () => provider);
  await router.start();
  const runtime = new Runtime(store, router);
  runtime.registry.put(seedForm());
  const app = await service(runtime);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const url = "http://127.0.0.1:" + (app.server.address() as any).port;
  const client = new RuntimeClient(url, store.token());
  const input = {
    goal: "Project uppercase label and twice the quantity",
    model: "scripted-test",
    input: '[{"name":"Alder","quantity":3}]',
    spec: {
      schemaVersion: 1,
      kind: "json_projection",
      source: { operation: "workspace_read", location: "input.json" },
      outputPath: "result.json",
      columns: [
        { name: "label", source: "name", transform: "uppercase" },
        { name: "double", source: "quantity", multiply: 2 },
      ],
    },
  };
  let id = "";
  try {
    assert.equal(
      (
        await fetch(url + "/api/artifact-tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        })
      ).status,
      401,
    );
    const run = await client.request(
      "/api/artifact-tasks",
      "POST",
      input,
      "same-request",
    );
    id = run.id;
    assert.equal(
      (
        await client.request(
          "/api/artifact-tasks",
          "POST",
          input,
          "same-request",
        )
      ).id,
      id,
    );
    await runtime.execute(id);
    assert.equal(
      store.run(id).status,
      "succeeded",
      store.run(id).error || "Expected API completion",
    );
    const detail = await client.request("/api/artifact-tasks/" + id);
    assert.equal(detail.attempts.length, 1);
    assert.equal(detail.state.verification.valid, true);
    assert.equal(
      (await client.artifactOutput(id)).content,
      '[{"label":"ALDER","double":6}]',
    );
    assert.equal(calls, 1);
    // Simulate lost onSend persistence after the task and configuration committed.
    store.db.prepare("DELETE FROM kv WHERE namespace='api-dedup'").run();
    const recovered = await client.request(
      "/api/artifact-tasks",
      "POST",
      input,
      "same-request",
    );
    assert.equal(recovered.id, id);
    assert.equal(store.list("artifact-configurations").length, 1);
    assert.equal(calls, 1);
    await assert.rejects(
      client.request(
        "/api/artifact-tasks",
        "POST",
        { ...input, model: "changed" },
        "same-request",
      ),
      /different artifact payload|different payload/,
    );
    await assert.rejects(
      client.request("/api/artifact-tasks", "POST", {
        ...input,
        spec: { ...input.spec, outputPath: "../examiner.json" },
      }),
      /protected|escapes|bounded relative/,
    );
    const caps = await client.request("/api/capabilities");
    assert.equal(caps.identity, "browser-fixture-v1");
  } finally {
    await app.close();
  }
  const restoredStore = new Store(root),
    restoredRouter = new DesktopRouter(restoredStore, () => provider);
  await restoredRouter.start();
  const restoredRuntime = new Runtime(restoredStore, restoredRouter);
  const restored = await service(restoredRuntime);
  await restored.listen({ host: "127.0.0.1", port: 0 });
  try {
    const restoredClient = new RuntimeClient(
      "http://127.0.0.1:" + (restored.server.address() as any).port,
      restoredStore.token(),
    );
    assert.equal(
      (await restoredClient.artifactOutput(id)).content,
      '[{"label":"ALDER","double":6}]',
    );
    assert.equal((await restoredClient.status(id)).status, "succeeded");
    assert.equal(calls, 1);
  } finally {
    await restored.close();
  }
});
