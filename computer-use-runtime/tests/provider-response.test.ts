import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  providerJson,
  PROVIDER_OUTPUT_BYTES,
  PROVIDER_METADATA_BYTES,
} from "../src/providers/transport.js";
import {
  LocalEndpointProvider,
  OllamaProvider,
} from "../src/providers/index.js";
import { LocalVisionAssessor } from "../src/providers/vision.js";

test(
  "Ollama text and vision bodies enforce limits and cancel after headers",
  { timeout: 10000 },
  async () => {
    let mode = "oversize",
      chats = 0,
      began!: () => void,
      closed!: () => void;
    let arrived = new Promise<void>((r) => (began = r)),
      disconnected = new Promise<void>((r) => (closed = r));
    const server = createServer((req, res) => {
      req.resume();
      if (req.url === "/api/show") {
        res.end(JSON.stringify({ capabilities: ["completion", "vision"] }));
        return;
      }
      chats++;
      if (mode === "error") res.statusCode = 503;
      res.writeHead(res.statusCode, { "content-type": "application/json" });
      res.once("close", () => closed());
      if (mode === "oversize") {
        res.write(" ".repeat(PROVIDER_OUTPUT_BYTES));
        res.end("{}");
      } else {
        res.write('{"message":');
        began();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const endpoint = "http://127.0.0.1:" + (server.address() as any).port;
    try {
      await assert.rejects(
        new OllamaProvider("fixture", endpoint).generate("public", {}),
        /byte budget/,
      );
      await assert.rejects(
        new LocalVisionAssessor("fixture", endpoint).assess(
          "public fixture",
          Buffer.from("public fixture bytes"),
        ),
        /byte budget/,
      );
      mode = "held";
      arrived = new Promise<void>((r) => (began = r));
      disconnected = new Promise<void>((r) => (closed = r));
      const abort = new AbortController();
      const pending = new OllamaProvider("fixture", endpoint).generate(
        "public",
        {},
        abort.signal,
      );
      const rejected = assert.rejects(pending, /stop held body/);
      await arrived;
      abort.abort(new Error("stop held body"));
      await rejected;
      await disconnected;
      mode = "error";
      disconnected = new Promise<void>((r) => (closed = r));
      await assert.rejects(
        new LocalEndpointProvider(endpoint, "fixture").generate("public", {}),
        /Provider 503/,
      );
      await disconnected;
      assert.equal(chats, 4);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  },
);

test("provider parser bounds UTF-8 bytes and cancels oversized or malformed bodies", async () => {
  const bytes = new TextEncoder().encode('{"name":"Ω"}');
  assert.deepEqual(await providerJson(new Response(bytes), bytes.length), {
    name: "Ω",
  });
  await assert.rejects(
    providerJson(new Response(bytes), bytes.length - 1),
    /byte budget/,
  );
  let cancelled = 0,
    reads = 0;
  const stream = () =>
    new ReadableStream<Uint8Array>({
      pull(c) {
        reads++;
        c.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled++;
      },
    });
  await assert.rejects(
    providerJson(
      new Response(stream(), { headers: { "content-length": "2000" } }),
      100,
    ),
    /byte budget/,
  );
  assert.equal(cancelled, 1);
  assert.ok(reads < 2);
  await assert.rejects(providerJson(new Response(stream()), 15), /byte budget/);
  assert.equal(cancelled, 2);
  await assert.rejects(providerJson(new Response("broken JSON"), 100), /JSON/);
  await assert.rejects(
    providerJson(new Response(new Uint8Array([255])), 100),
    /encoded data/,
  );
});

test(
  "provider cancellation interrupts a pending body read",
  { timeout: 3000 },
  async () => {
    let cancelled = false;
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const pending = providerJson(new Response(body), 100, controller.signal);
    const failed = assert.rejects(pending, /caller stop/);
    controller.abort(new Error("caller stop"));
    await failed;
    assert.equal(cancelled, true);
  },
);

test(
  "real loopback provider rejects chunked generation and readiness overflow",
  { timeout: 10000 },
  async () => {
    let chats = 0;
    const server = createServer((req, res) => {
      req.resume();
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/show" || req.url === "/api/tags") {
        res.write(" ".repeat(PROVIDER_METADATA_BYTES));
        res.end("{}");
      } else {
        chats++;
        res.write(" ".repeat(PROVIDER_OUTPUT_BYTES));
        res.end("{}");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const endpoint = "http://127.0.0.1:" + (server.address() as any).port;
    try {
      await assert.rejects(
        new LocalEndpointProvider(endpoint, "fixture").generate(
          "public fixture",
          {},
        ),
        /byte budget/,
      );
      assert.equal(chats, 1);
      await assert.rejects(
        new OllamaProvider("fixture", endpoint).generate("public fixture", {}),
        /byte budget/,
      );
      assert.equal(chats, 1, "Readiness failure must not send the prompt");
      const discovery = (await OllamaProvider.discover(endpoint)) as any;
      assert.equal(discovery.available, false);
      assert.match(discovery.reason, /byte budget/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
    }
  },
);
