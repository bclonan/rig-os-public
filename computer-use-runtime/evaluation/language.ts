import { mkdirSync, writeFileSync } from "node:fs";
import { Store } from "../src/storage/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { seedForm } from "../src/skills/index.js";
import { OllamaProvider } from "../src/providers/index.js";
import { compileIntent } from "../src/compiler/intent.js";
const store = new Store(".data/language-" + Date.now()),
  adapter = await new BrowserAdapter(store).start(),
  runtime = new Runtime(store, adapter);
runtime.registry.put(seedForm());
const results: any[] = [];
const provider = new OllamaProvider("qwen3.5:0.8b");
try {
  const target = {
    host: adapter.host,
    session: adapter.session,
    identity: adapter.identity,
  };
  for (const goal of [
    "Please change the display name on this form to Marigold 947.",
    "Open Paint and draw a dog",
    "Open the text editor, type Runtime evidence 947, and save the document.",
    "Calculate 137 plus 289 in Calculator.",
    "In Paint, draw a blue rectangle and save it.",
  ]) {
    const start = performance.now();
    try {
      const task = await compileIntent(
        goal,
        target,
        ["edit"],
        runtime.registry.list(),
        provider,
      );
      runtime.submit(task, task.id);
      await runtime.execute(task.id);
      results.push({
        goal,
        contract: task,
        status: store.run(task.id).status,
        latencyMs: performance.now() - start,
        events: store.events(0, task.id),
      });
    } catch (e) {
      results.push({
        goal,
        error: String(e),
        status: "FAIL",
        latencyMs: performance.now() - start,
      });
    }
  }
  const response = await fetch("http://127.0.0.1:11434/api/show", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: provider.model }),
  });
  const model = await response.json();
  mkdirSync("evidence/language", { recursive: true });
  writeFileSync("evidence/language/model.json", JSON.stringify(model, null, 2));
  writeFileSync(
    "evidence/language/results.json",
    JSON.stringify(results, null, 2),
  );
  console.log(
    JSON.stringify(
      results.map(({ goal, status, latencyMs, error }) => ({
        goal,
        status,
        latencyMs,
        error,
      })),
    ),
  );
} finally {
  await runtime.close();
}
