import { Store, hash } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { OllamaProvider } from "../src/providers/index.js";
import { seedForm, seal } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { writeFileSync } from "node:fs";
const store = new Store(".data/sourced-" + Date.now()),
  adapter = await new BrowserAdapter(store).start(),
  runtime = new Runtime(store, adapter);
const result: any = {
  status: "NOT RUN",
  level: "resettable live browser fixture, local documentation source",
  goal: "Read the workbench documentation and write a short sourced excerpt explaining the Apply action into the display-name result.",
};
try {
  const open = seal({
    ...seedForm(),
    id: "docs.open",
    inputs: {},
    capabilities: ["click"],
    preconditions: [],
    machine: {
      initial: "open",
      states: [
        {
          id: "open",
          steps: [
            {
              id: "open",
              operation: "click",
              scope: "edit",
              args: { locator: "documentation" },
            },
          ],
          monitor: ["focused"],
        },
      ],
    },
  });
  runtime.registry.put(open);
  const readTask = structuredTask(
    "Read the workbench documentation",
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    {},
    open.id,
  );
  readTask.expected = { docsOpen: true };
  runtime.submit(readTask, readTask.id);
  await runtime.execute(readTask.id);
  if (store.run(readTask.id).status !== "succeeded")
    throw new Error("Documentation could not be opened");
  const documentation = await adapter.page.locator("details").innerText();
  const source = adapter.page.url() + "#workbench-documentation";
  const plan: any = await new OllamaProvider("qwen3:1.7b").generate(
    "Extract one exact sentence from this documentation about applying the name. Return JSON with excerpt. Do not paraphrase or invent facts. Documentation: " +
      documentation,
    {
      type: "object",
      additionalProperties: false,
      properties: { excerpt: { type: "string" } },
      required: ["excerpt"],
    },
  );
  if (
    typeof plan.excerpt !== "string" ||
    !plan.excerpt.trim() ||
    !documentation.includes(plan.excerpt)
  )
    throw new Error("Citation does not match observed source");
  const output =
    plan.excerpt + " Source: " + source + " SHA256: " + hash(documentation);
  runtime.registry.put(seedForm());
  const task = structuredTask(
    result.goal,
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    { name: output },
  );
  runtime.submit(task, task.id);
  await runtime.execute(task.id);
  result.run = store.run(task.id);
  result.source = {
    uri: source,
    hash: hash(documentation),
    retrievedAt: new Date().toISOString(),
    excerpt: plan.excerpt,
  };
  result.output = await adapter.page.locator("#result").textContent();
  result.status =
    result.run.status === "succeeded" && result.output === output
      ? "PASS"
      : "FAIL";
  result.events = store.events(0, task.id);
  writeFileSync(
    "evidence/sourced-output.png",
    store.artifactRead((await adapter.observe()).image!),
  );
} catch (e) {
  result.status = "FAIL";
  result.reason = String(e);
} finally {
  await runtime.close();
  writeFileSync(
    "evidence/sourced-output.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ status: result.status, reason: result.reason }));
}
