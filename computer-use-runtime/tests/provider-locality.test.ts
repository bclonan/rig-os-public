import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OllamaProvider } from "../src/providers/index.js";
import { LocalVisionAssessor } from "../src/providers/vision.js";
test("loopback cloud aliases send no prompt or image generation request", async () => {
  let generated = 0,
    shown = 0;
  let metadata: object = {
    capabilities: ["completion", "vision"],
    remote_host: "https://ollama.com",
    remote_model: "cloud-model",
  };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/show") {
      shown++;
      response.end(JSON.stringify(metadata));
    } else {
      generated++;
      response.end(JSON.stringify({ message: { content: "{}" } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  try {
    for (const model of ["custom-alias", "model:cloud", "model:large-cloud"]) {
      await assert.rejects(
        () =>
          new OllamaProvider(model, endpoint).generate("PRIVATE PROMPT", {}),
        /cloud/i,
      );
      await assert.rejects(
        () =>
          new LocalVisionAssessor(model, endpoint).assess(
            "private subject",
            Buffer.from("PRIVATE IMAGE"),
          ),
        /cloud/i,
      );
    }
    assert.equal(generated, 0);
    assert.ok(shown >= 2);
    metadata = { capabilities: ["completion", "vision"] };
    assert.deepEqual(
      await new OllamaProvider("local-model", endpoint).generate(
        "public fixture",
        {},
      ),
      {},
    );
    assert.equal(generated, 1);
    metadata = { capabilities: ["completion"] };
    await assert.rejects(
      () =>
        new LocalVisionAssessor("text-only", endpoint).assess(
          "test",
          Buffer.from("PRIVATE IMAGE"),
        ),
      /vision/,
    );
    assert.equal(generated, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
