import test from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  LocalEndpointProvider,
  OllamaProvider,
} from "../src/providers/index.js";
import { LocalVisionAssessor } from "../src/providers/vision.js";
import { modelJson, rejectModelResponse } from "../src/providers/transport.js";

async function loopback(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  operation: (endpoint: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await operation(
      "http://127.0.0.1:" + (server.address() as { port: number }).port,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("Ollama omits unsupported thinking settings and never sends unsupported images", async () => {
  let capabilities = ["completion"];
  const requests: Record<string, unknown>[] = [];
  await loopback(
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/show")
          response.end(JSON.stringify({ capabilities }));
        else {
          requests.push(JSON.parse(Buffer.concat(chunks).toString()));
          response.end(JSON.stringify({ message: { content: '{"ok":true}' } }));
        }
      });
    },
    async (endpoint) => {
      const provider = new OllamaProvider("public-fixture", endpoint);
      assert.deepEqual(await provider.generate("Public fixture", {}), {
        ok: true,
      });
      assert.equal(Object.hasOwn(requests[0], "think"), false);
      await assert.rejects(
        provider.generate("Private prompt", {}, undefined, ["PRIVATE IMAGE"]),
        /vision capability/,
      );
      await assert.rejects(
        provider.generate("Private prompt", {}, undefined, undefined, true),
        /thinking capability/,
      );
      await assert.rejects(
        new LocalVisionAssessor("public-fixture", endpoint).assess(
          "private subject",
          Buffer.from("PRIVATE IMAGE"),
        ),
        /vision capability/,
      );
      assert.equal(requests.length, 1);
      capabilities = ["completion", "vision", "thinking"];
      await provider.generate("Public fixture", {}, undefined, ["PUBLIC PNG"]);
      assert.equal(requests[1].think, false);
      assert.deepEqual(provider.capabilities.modalities, ["text", "image"]);
    },
  );
});

test("Ollama HTTP400 reports a safe cause and never repeats a generation request", async () => {
  let chats = 0;
  await loopback(
    (request, response) => {
      request.resume();
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/show")
        response.end(
          JSON.stringify({ capabilities: ["completion", "vision"] }),
        );
      else {
        chats++;
        response.statusCode = 400;
        response.end(
          JSON.stringify({
            error:
              "input length exceeds context window. PRIVATE_PROMPT secret-token C:\\PrivateFixture\\PRIVATE_USER",
          }),
        );
      }
    },
    async (endpoint) => {
      const provider = new OllamaProvider("public-fixture", endpoint);
      await assert.rejects(
        provider.generate("PRIVATE_PROMPT", {}),
        (error: Error) => {
          assert.match(error.message, /HTTP 400.+context window/);
          assert.match(error.message, /No desktop action was sent/);
          assert.doesNotMatch(
            error.message,
            /PRIVATE|secret-token|PrivateFixture/,
          );
          return true;
        },
      );
      assert.equal(chats, 1);
    },
  );
});

test("named thinking levels use the advertised default instead of unsupported false", async () => {
  const requests: Record<string, unknown>[] = [];
  await loopback(
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/show") {
          response.end(
            JSON.stringify({
              capabilities: ["completion", "thinking"],
              thinking: {
                values: ["low", "medium", "high"],
                default: "medium",
              },
            }),
          );
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(body);
        if (
          Object.hasOwn(body, "think") &&
          !["low", "medium", "high"].includes(body.think)
        ) {
          response.statusCode = 400;
          response.end(JSON.stringify({ error: "unsupported thinking value" }));
        } else
          response.end(JSON.stringify({ message: { content: '{"ok":true}' } }));
      });
    },
    async (endpoint) => {
      const provider = new OllamaProvider("named-thinking-fixture", endpoint);
      assert.deepEqual(await provider.generate("Public fixture", {}), {
        ok: true,
      });
      assert.equal(Object.hasOwn(requests[0], "think"), false);
      assert.deepEqual(
        await provider.generate(
          "Public fixture",
          {},
          undefined,
          undefined,
          true,
        ),
        { ok: true },
      );
      assert.equal(requests[1].think, "medium");
    },
  );
});

test(
  "error diagnostics bound stalled bodies and malformed output cannot echo private data",
  { timeout: 3000 },
  async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const began = performance.now();
    await assert.rejects(
      rejectModelResponse(
        new Response(stream, { status: 400 }),
        "Ollama generation",
      ),
      /HTTP 400/,
    );
    assert.equal(cancelled, true);
    assert.ok(performance.now() - began < 2000);
    await assert.rejects(
      rejectModelResponse(
        new Response(
          JSON.stringify({ error: "PRIVATE_PROMPT " + "x".repeat(10000) }),
          { status: 400 },
        ),
        "Ollama generation",
      ),
      (error: Error) => {
        assert.match(error.message, /HTTP 400/);
        assert.doesNotMatch(error.message, /PRIVATE_PROMPT/);
        return true;
      },
    );
    assert.throws(
      () => modelJson("PRIVATE_PROMPT malformed JSON"),
      (error: Error) => {
        assert.match(error.message, /invalid JSON/);
        assert.doesNotMatch(error.message, /PRIVATE_PROMPT/);
        return true;
      },
    );
  },
);

test("OpenAI-compatible screenshots require declared vision and use image content blocks", async () => {
  const requests: Record<string, any>[] = [];
  await loopback(
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.end(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true}' } }],
          }),
        );
      });
    },
    async (endpoint) => {
      await assert.rejects(
        new LocalEndpointProvider(endpoint, "public-fixture").generate(
          "PRIVATE_PROMPT",
          {},
          undefined,
          ["PRIVATE_IMAGE"],
        ),
        /text only/,
      );
      assert.equal(requests.length, 0);
      await new LocalEndpointProvider(endpoint, "public-fixture", {
        vision: true,
        maxTokens: 512,
      }).generate("Public prompt", {}, undefined, ["PUBLIC_IMAGE"]);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].max_tokens, 512);
      assert.deepEqual(requests[0].messages[0].content, [
        { type: "text", text: "Public prompt" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,PUBLIC_IMAGE" },
        },
      ]);
      assert.throws(
        () =>
          new LocalEndpointProvider(endpoint, "public-fixture", {
            maxTokens: 0,
          }),
        /token limit/,
      );
    },
  );
});
