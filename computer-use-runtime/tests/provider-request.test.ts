import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { LocalEndpointProvider } from "../src/providers/index.js";

async function within<T>(pending: Promise<T>, timeout: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Loopback request deadline exceeded")),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  "generic local provider sends its advertised generation limit and cancels a held request",
  { timeout: 10000 },
  async () => {
    const requests: { url: string | undefined; body: any }[] = [];
    let arrived!: () => void;
    let disconnected!: () => void;
    const pendingArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const pendingDisconnected = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push({
          url: request.url,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
        if (requests.length === 1) {
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              choices: [{ message: { content: '{"ok":true}' } }],
            }),
          );
        } else {
          response.once("close", disconnected);
          arrived();
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    const provider = new LocalEndpointProvider(
      "http://127.0.0.1:" + address.port + "/v1",
      "installed-fixture-model",
    );
    const schema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
    };
    try {
      assert.equal(provider.capabilities.maxTokens, 4096);
      assert.deepEqual(
        await provider.generate("Public fixture response", schema),
        { ok: true },
      );
      assert.equal(requests[0].url, "/v1/chat/completions");
      assert.equal(
        requests[0].body.max_tokens,
        provider.capabilities.maxTokens,
      );
      assert.equal(requests[0].body.model, "installed-fixture-model");
      assert.deepEqual(
        requests[0].body.response_format.json_schema.schema,
        schema,
      );

      const abort = new AbortController();
      const pending = provider.generate(
        "Public cancellation fixture",
        schema,
        abort.signal,
      );
      const rejected = assert.rejects(pending, /fixture cancellation|abort/i);
      await within(pendingArrived, 2000);
      const began = performance.now();
      abort.abort(new Error("fixture cancellation"));
      await rejected;
      await within(pendingDisconnected, 2000);
      assert.ok(
        performance.now() - began < 2000,
        "Caller cancellation must close the pending HTTP request",
      );
      assert.equal(requests.length, 2);
      assert.equal(
        requests[1].body.max_tokens,
        provider.capabilities.maxTokens,
      );
      assert.equal(provider.capabilities.cancellation, true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
