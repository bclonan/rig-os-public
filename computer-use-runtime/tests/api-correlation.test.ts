import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { Store } from "../src/storage/index.js";
import { service } from "../src/service/index.js";
import { exportDataset } from "../src/recorder/bundle.js";
import { seedForm, seal } from "../src/skills/index.js";
import { PermissionedTools } from "../src/tools/index.js";

test("dataset, model and skill requests preserve their execution correlation across HTTP retry and store restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "cur-api-correlation-"));
  const store = new Store(join(root, "store"));
  const adapter = await new BrowserAdapter(store).start();
  const runtime = new Runtime(store, adapter);
  runtime.registry.put(seedForm());
  const app = await service(runtime);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const url = "http://127.0.0.1:" + address.port;
  const token = store.token();
  const expected = new Map<string, string>();
  try {
    const skill = seal({ ...seedForm(), id: "correlation.imported" });
    const requests = [
      { route: "/api/datasets/import", payload: exportDataset(store) },
      { route: "/api/models/rollback", payload: {} },
      { route: "/api/skills/import", payload: skill },
    ];
    for (const { route, payload } of requests) {
      const correlationId = randomUUID(),
        idempotencyKey = randomUUID();
      const post = (correlation: string, body: unknown = payload) =>
        fetch(url + route, {
          method: "POST",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
            "x-correlation-id": correlation,
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify(body),
        });
      const response = await post(correlationId);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("x-correlation-id"), correlationId);
      const payloadText = await response.text();
      const replay = await post("retry-" + randomUUID());
      assert.equal(replay.status, 200);
      assert.equal(replay.headers.get("x-correlation-id"), correlationId);
      assert.equal(await replay.text(), payloadText);
      const entry = store.get<any>(
        "api-dedup",
        route + ":{}:" + idempotencyKey,
      );
      assert.equal(entry.correlationId, correlationId);
      assert.equal(entry.payload, payloadText);
      expected.set(route + ":{}:" + idempotencyKey, correlationId);
      const conflict = await post("conflict-request", {
        invalidReplacement: true,
      });
      assert.equal(conflict.status, 409);
      assert.equal(
        conflict.headers.get("x-correlation-id"),
        "conflict-request",
      );
      assert.equal(
        store.get<any>("api-dedup", route + ":{}:" + idempotencyKey)
          .correlationId,
        correlationId,
      );
    }
    const capabilities = await fetch(url + "/api/capabilities", {
      headers: {
        authorization: "Bearer " + token,
        "x-correlation-id": "capabilities-request",
      },
    });
    assert.equal(capabilities.status, 200);
    assert.equal(
      capabilities.headers.get("x-correlation-id"),
      "capabilities-request",
    );
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const tools = new PermissionedTools(store, {
      root: workspace,
      exclusiveRoot: true,
      allowedOrigins: [],
      permissions: ["workspace_write"],
    });
    const request = {
      id: randomUUID(),
      runId: "correlated-tool-run",
      correlationId: "tool-operation",
      requester: "test-user",
      operation: "workspace_write" as const,
      args: { path: "result.txt", content: "Exact correlated output" },
      deadline: Date.now() + 5000,
    };
    const receipt = await tools.execute(request);
    assert.deepEqual(await tools.execute(request), receipt);
    assert.equal(
      readFileSync(join(workspace, "result.txt"), "utf8"),
      request.args.content,
    );
    assert.ok(store.events(0, request.runId).length > 0);
    assert.ok(
      store
        .events(0, request.runId)
        .every((event) => event.correlationId === request.correlationId),
    );
  } finally {
    await app.close();
  }
  const reopened = new Store(join(root, "store"));
  try {
    for (const [key, correlationId] of expected)
      assert.equal(
        reopened.get<any>("api-dedup", key).correlationId,
        correlationId,
      );
    assert.ok(
      reopened
        .events(0, "correlated-tool-run")
        .every((event) => event.correlationId === "tool-operation"),
    );
  } finally {
    reopened.close();
  }
});
