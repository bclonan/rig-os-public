import assert from "node:assert/strict";
import { test } from "node:test";
import { OculixBackend } from "../src/adapters/oculix.js";
import { checkCaptureOnlyBoundary } from "../evaluation/oculix.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeClient, WindowsAdapter } from "../src/adapters/native.js";
import type { Action } from "../src/contracts/index.js";
import { Lease } from "../src/runtime/policy.js";
import { Store } from "../src/storage/index.js";

const captureOnlyFixture = () => {
  const backend = new OculixBackend();
  // Controlled tool inventory tests dispatch restrictions without a JVM or OS effect.
  (backend as unknown as { tools: Map<string, unknown> }).tools = new Map(
    [
      "oculix_screenshot",
      "oculix_click_at_point",
      "oculix_type_text",
      "oculix_key_combo",
      "oculix_scroll",
    ].map((name) => [name, { name, inputSchema: { type: "object" } }]),
  );
  return backend;
};

test("pinned Oculix tool inventory exposes capture only and rejects input before contacting MCP", async () => {
  const backend = captureOnlyFixture();
  let toolCalls = 0;
  backend.client.callTool = async () => {
    toolCalls++;
    throw new Error("Input must not contact the MCP subprocess");
  };
  const report = await checkCaptureOnlyBoundary(backend);
  assert.equal(report.status, "PASS");
  assert.equal(toolCalls, 0);
  await backend.close();
});

test("Windows routing keeps capture-only Oculix out of input and passes the complete action to guarded native dispatch", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-oculix-route-")));
  const backend = captureOnlyFixture();
  const lease = new Lease();
  const calls: { method: string; args: any }[] = [];
  let oculixCalls = 0;
  backend.client.callTool = async () => {
    oculixCalls++;
    throw new Error("Oculix cannot perform input");
  };
  const client = {
    async call(method: string, args: any = {}) {
      calls.push({ method, args });
      if (method === "capabilities")
        return {
          host: "mock-host",
          session: "mock-session",
          operations: ["observe", "click"],
        };
      if (method === "windows") return [{ handle: 1, pid: 9 }];
      if (method === "resolve_target") return { handle: 1 };
      if (method === "fixture_text") return { text: "owned fixture" };
      if (method === "accessibility") return [];
      if (method === "observe")
        return {
          id: "bound-capture",
          host: "mock-host",
          session: "mock-session",
          at: Date.now(),
          revision: "stable",
          focused: true,
          title: "mock owned fixture",
          frame: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
          image: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString(
            "base64",
          ),
        };
      if (method === "acquire")
        return { generation: lease.acquire(args.runId) };
      if (method === "release") return lease.release(args.runId);
      if (method === "execute") {
        lease.check(args);
        assert.equal(args.target, 1);
        return { acknowledged: true, backend: "rust-win32-v1" };
      }
      throw new Error("Unexpected mock dispatch " + method);
    },
    async close() {},
  };
  const adapter = await new WindowsAdapter(
    store,
    false,
    client as unknown as NativeClient,
  ).start(1);
  (adapter as unknown as { oculix: OculixBackend }).oculix = backend;
  try {
    const observation = await adapter.observe();
    const generation = await adapter.acquire("owned-run");
    const action: Action = {
      schemaVersion: 1,
      id: "owned-action",
      runId: "owned-run",
      requester: "fixture-requester",
      host: adapter.host,
      session: adapter.session,
      target: adapter.identity,
      observationId: observation.id,
      revision: observation.revision,
      frame: observation.frame,
      operation: "click",
      args: { x: 0, y: 0 },
      deadline: Date.now() + 10000,
      scope: "edit",
      generation,
    };
    const receipt = await adapter.execute(action);
    assert.equal(receipt.phase, "acknowledged");
    assert.equal(receipt.backend, "rust-win32-v1");
    assert.equal(oculixCalls, 0);
    assert.deepEqual(calls.find((call) => call.method === "execute")!.args, {
      ...action,
      target: 1,
    });
    await adapter.release("owned-run");
    await assert.rejects(
      () => adapter.execute({ ...action, id: "unowned-action" }),
      /Invalid input lease/,
    );
    assert.equal(oculixCalls, 0);
  } finally {
    await adapter.close();
    store.close();
  }
});
