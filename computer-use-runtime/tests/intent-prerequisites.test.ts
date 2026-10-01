import { test } from "node:test";
import assert from "node:assert/strict";
import { compileIntent, structuredTask } from "../src/compiler/intent.js";
import { seal, seedForm } from "../src/skills/index.js";
import type { ModelProvider } from "../src/contracts/ports.js";

test("intent compilation retains user origins and expands nested prerequisites without granting child effects", async () => {
  const target = {
    host: "test",
    session: "test",
    identity: "browser-fixture-v1",
  };
  const leaf = seal({
    ...seedForm(),
    id: "leaf",
    preconditions: ["docsOpen", "ready"],
    effects: ["save"],
  });
  const middle = seal({
    ...seedForm(),
    id: "middle",
    preconditions: ["focused"],
    dependencies: [leaf.id],
  });
  const parent = seal({
    ...seedForm(),
    id: "parent",
    dependencies: [middle.id],
  });
  const submitted = structuredTask(
    "Draw a dog without saving",
    target,
    { name: "requested" },
    parent.id,
  );
  submitted.requirements.push({
    name: "destination",
    value: "not requested",
    origin: "unresolved",
  });
  const provider: ModelProvider = {
    capabilities: {
      schemaVersion: 1,
      id: "scripted-unit-double",
      modalities: ["text"],
      structuredOutput: true,
      tools: false,
      cancellation: true,
      local: true,
      maxTokens: 1000,
      available: true,
    },
    async generate() {
      return structuredClone(submitted);
    },
  };
  const task = await compileIntent(
    submitted.goal,
    target,
    ["edit"],
    [parent, middle, leaf],
    provider,
  );
  assert.deepEqual(task.effects, ["edit"]);
  assert.equal(
    task.requirements.find((r) => r.name === "outcome")?.origin,
    "user_explicit",
  );
  assert.equal(
    task.requirements.find((r) => r.name === "destination")?.origin,
    "unresolved",
  );
  assert.ok(
    task.unresolved.includes(
      "Unresolved requirement: destination: not requested",
    ),
  );
  assert.deepEqual(
    task.requirements
      .filter((r) => r.origin === "method_precondition")
      .map((r) => r.name)
      .sort(),
    ["docsOpen", "focused", "ready"],
  );
  assert.ok(
    task.unresolved.includes("Method requires an unauthorized effect: leaf"),
  );
  const missing = await compileIntent(
    submitted.goal,
    target,
    ["edit"],
    [parent, middle],
    provider,
  );
  assert.ok(missing.unresolved.includes("Missing prerequisite skill: leaf"));
  const cycle = seal({ ...leaf, dependencies: [parent.id] });
  await assert.rejects(
    () =>
      compileIntent(
        submitted.goal,
        target,
        ["edit"],
        [parent, middle, cycle],
        provider,
      ),
    /Recursive method prerequisite/,
  );
});
