import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, canonical } from "../src/storage/index.js";
import { WorkspaceAdapter } from "../src/adapters/workspace.js";
import { Runtime } from "../src/runtime/index.js";
import { seal, seedForm } from "../src/skills/index.js";
import type { ModelProvider } from "../src/contracts/ports.js";
import type { TaskContract, Action } from "../src/contracts/index.js";
import {
  freezeArtifactSpec,
  verifyArtifact,
  type ArtifactSpec,
} from "../src/assistant/artifact.js";

function setup(spec: ArtifactSpec, source: string, answers: string[]) {
  const base = mkdtempSync(join(tmpdir(), "cur-artifact-")),
    root = join(base, "workspace");
  mkdirSync(root);
  writeFileSync(join(root, spec.source.location), source);
  const store = new Store(join(base, "store"));
  let calls = 0;
  const provider: ModelProvider = {
    capabilities: {
      schemaVersion: 1,
      id: "scripted-test-double",
      modalities: ["text"],
      structuredOutput: true,
      tools: false,
      cancellation: true,
      local: true,
      maxTokens: 4096,
      available: true,
    },
    async generate(prompt) {
      assert.ok(prompt.includes("Authorized source bytes"));
      const content = answers[Math.min(calls++, answers.length - 1)];
      return spec.kind === "json_projection"
        ? { rows: JSON.parse(content) }
        : { content };
    },
  };
  const adapter = new WorkspaceAdapter(
    store,
    {
      root,
      exclusiveRoot: true,
      allowedOrigins: [],
      permissions: ["workspace_read", "workspace_write"],
    },
    provider,
    spec,
  );
  const runtime = new Runtime(store, adapter);
  const skill = seal({
    ...seedForm(),
    id: "artifact.construct",
    inputs: { configHash: "string" },
    outputs: ["artifactValid"],
    preconditions: ["ready"],
    capabilities: ["construct_artifact", "repair_artifact"],
    effects: ["workspace_read", "workspace_write"],
    compatibility: [adapter.identity],
    budgets: { steps: 5, retries: 2 },
    machine: {
      initial: "construct",
      onVerificationError: "repair",
      states: [
        {
          id: "construct",
          steps: [
            {
              id: "make",
              operation: "construct_artifact",
              args: {},
              scope: "workspace_write",
            },
          ],
          monitor: ["ready"],
        },
        {
          id: "repair",
          steps: [
            {
              id: "repair",
              operation: "repair_artifact",
              args: {},
              scope: "workspace_write",
            },
          ],
          monitor: ["ready"],
        },
      ],
    },
  });
  runtime.registry.put(skill);
  const task: TaskContract = {
    schemaVersion: 1,
    id: randomUUID(),
    correlationId: randomUUID(),
    requester: "fixture-user",
    goal: "Create the requested transformed output from the authorized source",
    target: {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    parameters: { configHash: adapter.constructorAgent.configHash },
    effects: ["workspace_read", "workspace_write"],
    requirements: [
      {
        name: "output-criteria",
        value: canonical(spec),
        origin: "user_explicit",
      },
    ],
    unresolved: [],
    method: skill.id,
    expected: { artifactValid: true },
    budgets: { steps: 5, deadlineMs: 10000 },
  };
  return { store, root, adapter, runtime, task, getCalls: () => calls };
}
const jsonSpec: ArtifactSpec = {
  schemaVersion: 1,
  kind: "json_projection",
  source: { operation: "workspace_read", location: "source.json" },
  outputPath: "output.json",
  columns: [
    { name: "label", source: "name", transform: "uppercase" },
    { name: "doubled", source: "amount", multiply: 2 },
  ],
  filter: { field: "amount", operator: "gte", value: 5 },
  sortBy: "label",
};
test("artifact runtime constructs output, detects wrong values, repairs and independently re-verifies", async () => {
  const context = setup(
    jsonSpec,
    '[{"name":"cedar","amount":7},{"name":"ash","amount":3}]',
    ['[{"label":"CEDAR","doubled":13}]', '[{"label":"CEDAR","doubled":14}]'],
  );
  try {
    context.runtime.submit(context.task, context.task.id);
    await context.runtime.execute(context.task.id);
    assert.equal(
      context.store.run(context.task.id).status,
      "succeeded",
      context.store.run(context.task.id).error ?? "",
    );
    assert.equal(context.getCalls(), 2);
    assert.equal(
      readFileSync(join(context.root, "output.json"), "utf8"),
      '[{"label":"CEDAR","doubled":14}]',
    );
    const attempts = context.store
      .list<{
        sequence: number;
        verification: { valid: boolean; sourceHash: string };
      }>("artifact-attempts")
      .sort((a, b) => a.sequence - b.sequence);
    assert.deepEqual(
      attempts.map((a) => a.verification.valid),
      [false, true],
    );
    assert.equal(
      attempts[0].verification.sourceHash,
      attempts[1].verification.sourceHash,
    );
    assert.ok(
      context.store
        .events(0, context.task.id)
        .some((e) => e.type === "verification_recovery"),
    );
  } finally {
    await context.runtime.close();
  }
});
test("CSV filters and transforms validate every row, quoted field and numeric value", async () => {
  const spec: ArtifactSpec = {
    schemaVersion: 1,
    kind: "csv_transform",
    source: { operation: "workspace_read", location: "source.csv" },
    outputPath: "output.csv",
    columns: [
      { name: "item", source: "name", transform: "uppercase" },
      { name: "total", source: "price", transform: "number", multiply: 3 },
    ],
    filter: { field: "price", operator: "gte", value: 4 },
  };
  const source = 'name,price\n"cedar, red",4\nash,2\n';
  const good = 'item,total\n"CEDAR, RED",12\n';
  assert.equal(
    verifyArtifact(spec, Buffer.from(source), Buffer.from(good)).valid,
    true,
  );
  assert.equal(
    verifyArtifact(
      spec,
      Buffer.from(source),
      Buffer.from(good.replace("12", "11")),
    ).valid,
    false,
  );
  assert.equal(
    verifyArtifact(spec, Buffer.from(source), Buffer.from("item,total\n"))
      .valid,
    false,
  );
  const context = setup(spec, source, [good]);
  try {
    context.runtime.submit(context.task, context.task.id);
    await context.runtime.execute(context.task.id);
    assert.equal(context.store.run(context.task.id).status, "succeeded");
  } finally {
    await context.runtime.close();
  }
});
test("bad construction stays failed under bounded repair and cannot change verifier scope", async () => {
  const context = setup(jsonSpec, '[{"name":"cedar","amount":7}]', [
    '[{"label":"CEDAR","doubled":0}]',
  ]);
  try {
    context.runtime.submit(context.task, context.task.id);
    await context.runtime.execute(context.task.id);
    assert.notEqual(context.store.run(context.task.id).status, "succeeded");
    assert.ok(context.getCalls() >= 2 && context.getCalls() <= 3);
    assert.equal(
      context.store
        .events(0, context.task.id)
        .some(
          (e) =>
            e.type === "completed" &&
            (e.data as { status?: string }).status === "succeeded",
        ),
      false,
    );
    await context.adapter.prepare(context.task);
    const observed = await context.adapter.observe(),
      generation = await context.adapter.acquire(context.task.id);
    const action: Action = {
      schemaVersion: 1,
      id: randomUUID(),
      runId: context.task.id,
      requester: context.task.requester,
      host: context.adapter.host,
      session: context.adapter.session,
      target: context.adapter.identity,
      observationId: observed.id,
      revision: observed.revision,
      frame: observed.frame,
      operation: "construct_artifact",
      args: { outputPath: "acceptance.json" },
      deadline: Date.now() + 5000,
      scope: "workspace_write",
      generation,
    };
    assert.equal((await context.adapter.execute(action)).phase, "rejected");
    await assert.rejects(
      () =>
        context.adapter.prepare({
          ...context.task,
          parameters: { configHash: "changed" },
        }),
      /frozen/,
    );
    assert.throws(
      () =>
        freezeArtifactSpec({
          ...jsonSpec,
          columns: [{ name: "unsafe", source: "constructor" }],
        }),
      /safe/,
    );
  } finally {
    await context.runtime.close();
  }
});
