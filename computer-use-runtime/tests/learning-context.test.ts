import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action, Observation, RunEvent } from "../src/contracts/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import {
  earlierActions,
  encodeContext,
  productionContext,
  advisoryContext,
  visualContext,
  visualStateContext,
} from "../src/learner/context.js";
import { screenshotTensor } from "../src/learner/image.js";
import { bitmapToPng } from "../src/adapters/png.js";
import { Store, hash } from "../src/storage/index.js";
import { Controller } from "../src/learner/index.js";
import { Registry, seedForm, seal } from "../src/skills/index.js";
import { AdaptiveSelector } from "../src/learner/selector.js";

const observation: Observation = {
  schemaVersion: 1,
  id: "now",
  host: "host",
  session: "session",
  target: "browser-fixture-v1",
  at: 2000,
  revision: "revision",
  frame: { x: 0, y: 0, width: 32, height: 32, scale: 1 },
  focused: true,
  facts: { ready: true, focused: true },
  features: [1, 0.5, 0.25],
  backend: "test",
};
const task = structuredTask(
  "Update the authorized form",
  {
    host: observation.host,
    session: observation.session,
    identity: observation.target,
  },
  { name: "Private answer" },
);
const action: Action = {
  schemaVersion: 1,
  id: "previous-input",
  runId: "old-run",
  requester: task.requester,
  host: observation.host,
  session: observation.session,
  target: observation.target,
  observationId: "old",
  revision: "old",
  frame: observation.frame,
  operation: "click",
  args: { locator: "open" },
  deadline: 3000,
  scope: "edit",
  generation: 1,
};

test("pre-action history uses actual earlier delivered actions and excludes future, other target and uncertain delivery", () => {
  const event = (
    seq: number,
    at: number,
    target = observation.target,
    phase = "acknowledged",
  ): RunEvent => ({
    schemaVersion: 1,
    seq,
    runId: "old-run",
    correlationId: "correlation",
    at,
    type: "experience",
    data: {
      before: { ...observation, target, at: 1000 },
      action: { ...action, id: "input-" + seq, target },
      receipt: { actionId: "input-" + seq, phase },
      after: { ...observation, target, at },
    },
  });
  const entries = earlierActions(
    [
      event(1, 1500),
      event(2, 3000),
      event(3, 1500, "other"),
      event(4, 1500, observation.target, "uncertain"),
    ],
    observation,
  );
  assert.deepEqual(
    entries.map((entry) => entry.action.id),
    ["input-1"],
  );
  const context = encodeContext(task, observation, entries, 1000);
  assert.equal(context[13], 1);
  assert.equal(context[23], 1);
  const changedAnswer = {
    ...task,
    expected: { result: "Evaluator-only answer" },
    parameters: { name: "Different private answer" },
  };
  assert.deepEqual(
    encodeContext(changedAnswer, observation, entries, 1000),
    context,
  );
  assert.notDeepEqual(
    encodeContext(
      { ...task, goal: "Cancel the authorized operation" },
      observation,
      entries,
      1000,
    ),
    context,
  );
  assert.notDeepEqual(encodeContext(task, observation, [], 1000), context);
});

test("native screenshots become actual bounded RGB tensors and invalid captures abstain", () => {
  const bitmap = Buffer.alloc(54 + 32 * 32 * 4);
  bitmap.write("BM");
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(32, 18);
  bitmap.writeInt32LE(-32, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(32, 28);
  for (let pixel = 54; pixel < bitmap.length; pixel += 4) {
    bitmap[pixel] = 32;
    bitmap[pixel + 1] = 64;
    bitmap[pixel + 2] = 128;
  }
  const png = bitmapToPng(bitmap),
    pixels = screenshotTensor(png);
  assert.equal(pixels.length, 3072);
  assert.equal(pixels[0], Math.fround(128 / 255));
  assert.equal(pixels[1024], Math.fround(64 / 255));
  assert.equal(pixels[2048], Math.fround(32 / 255));
  assert.throws(
    () => screenshotTensor(png, { x: 32, y: 0, width: 1, height: 1 }),
    /escapes/,
  );
  const corrupt = Buffer.from(png);
  corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => screenshotTensor(corrupt), /checksum/);
});

test("production history stays recent after 5000 events and isolates requester, target and task budget", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-history-page-")));
  try {
    store.transaction(() => {
      for (let i = 0; i < 5001; i++)
        store.append("noise", "noise", {}, "noise");
    });
    const at = Date.now();
    const before = { ...observation, at: at - 10 };
    const current = { ...observation, at: at + 100 };
    const append = (
      id: string,
      requester: string,
      runId: string,
      target = current.target,
    ) => {
      const input = { ...action, id, requester, runId, target };
      store.append(
        runId,
        "experience",
        {
          before: { ...before, target },
          action: input,
          receipt: { actionId: id, phase: "acknowledged" },
          after: { ...before, target, at },
        },
        "history",
      );
    };
    append("same-1", task.requester, task.id);
    append("same-2", task.requester, task.id);
    append("same-3", task.requester, task.id);
    append("earlier-task", task.requester, "old-run");
    append("other-requester", "someone-else", task.id);
    append("other-target", task.requester, task.id, "other-target");
    const result = productionContext(store, task, current, at - 20);
    assert.deepEqual(
      result.previous.map((entry) => entry.action.id),
      ["same-3", "earlier-task"],
    );
    assert.equal(result.context[33], Math.fround(1 - 3 / task.budgets.steps));
    assert.equal(result.context[11], 1);
    assert.equal(result.context[23], 1);
  } finally {
    store.close();
  }
});

test("selector masks incompatible published skills, missing types and unknown preconditions before selection", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-selector-context-")));
  const selector = new AdaptiveSelector(store, ["fill", "click"]);
  try {
    const registry = new Registry(store);
    registry.put(seedForm());
    registry.put(
      seal({
        ...seedForm(),
        id: "foreign.compiled",
        status: "published",
        compatibility: ["other-target"],
        provenance: {
          kind: "compiled",
          demonstrations: [],
          tests: [],
          uncertain: [],
        },
      }),
    );
    registry.put(
      seal({
        ...seedForm(),
        id: "untyped.compiled",
        status: "published",
        inputs: { missing: "number" },
        provenance: {
          kind: "compiled",
          demonstrations: [],
          tests: [],
          uncertain: [],
        },
      }),
    );
    registry.put(
      seal({
        ...seedForm(),
        id: "unknown.compiled",
        status: "published",
        preconditions: ["missing"],
        provenance: {
          kind: "compiled",
          demonstrations: [],
          tests: [],
          uncertain: [],
        },
      }),
    );
    registry.put(
      seal({ ...seedForm(), id: "unsupported.child", capabilities: ["type"] }),
    );
    registry.put(
      seal({
        ...seedForm(),
        id: "invalid.nested",
        status: "published",
        dependencies: ["unsupported.child"],
        machine: {
          initial: "nested",
          states: [
            {
              id: "nested",
              steps: [
                {
                  id: "child",
                  operation: "subskill",
                  subskill: "unsupported.child",
                  args: {},
                  scope: "edit",
                },
              ],
              monitor: ["focused"],
            },
          ],
        },
        provenance: {
          kind: "compiled",
          demonstrations: [],
          tests: [],
          uncertain: [],
        },
      }),
    );
    store.putRun({
      id: task.id,
      contract: task,
      status: "queued",
      cursor: 0,
      skill: "auto",
      model: "fixed",
      bindings: {},
    });
    const selected = await selector.select(task, observation, registry);
    assert.equal(selected.id, "form.seed");
    registry.put(
      seal({
        ...seedForm(),
        id: "dynamic.compiled",
        status: "published",
        inputs: { label: "string" },
        machine: {
          initial: "edit",
          states: [
            {
              id: "edit",
              steps: [
                {
                  id: "fill",
                  operation: "fill",
                  args: { locator: "name", value: "$label" },
                  scope: "edit",
                },
              ],
              monitor: ["focused"],
            },
          ],
        },
        provenance: {
          kind: "compiled",
          demonstrations: [],
          tests: [],
          uncertain: [],
        },
      }),
    );
    const dynamic = { ...task, parameters: { label: "New input schema" } };
    assert.equal(
      (await selector.select(dynamic, observation, registry)).id,
      "dynamic.compiled",
    );
    await assert.rejects(
      () => selector.select({ ...task, parameters: {} }, observation, registry),
      /No compatible/,
    );
  } finally {
    await selector.close();
    store.close();
  }
});

test("old registered checkpoints retain their original context while v2 checkpoints receive live task context", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-legacy-context-")));
  const original = Controller.prototype.rank;
  const contexts: (Float32Array | undefined)[] = [];
  // The score choice is fixed only to isolate the argument compatibility check.
  // The real ONNX session still loads and computes every output.
  Controller.prototype.rank = async function (o, skills, history, pixels) {
    contexts.push(history);
    return {
      ...(await original.call(this, o, skills, history, pixels)),
      index: 0,
    };
  };
  const selector = new AdaptiveSelector(store, ["fill", "click", "observe"]);
  try {
    const path = "models/17/trained.onnx";
    const registry = new Registry(store);
    registry.put(seedForm());
    store.put("models", "legacy", {
      schemaVersion: 1,
      id: "legacy",
      hash: hash(readFileSync(path)),
      seed: 17,
      format: "onnx",
      parameters: 10041,
      status: "candidate",
      metrics: { contextVersion: 1 },
    });
    store.put("model-path", "legacy", path);
    store.putRun({
      id: task.id,
      contract: task,
      status: "queued",
      cursor: 0,
      skill: "auto",
      model: "legacy",
      bindings: {},
    });
    await selector.select(task, observation, registry);
    assert.equal(contexts[0], undefined);
    store.put("models", "legacy", {
      ...(store.get("models", "legacy") as object),
      metrics: { contextVersion: 2 },
    });
    await selector.select(task, observation, registry);
    assert.ok(contexts[1] instanceof Float32Array);
    assert.deepEqual(contexts[1], encodeContext(task, observation, []));
  } finally {
    Controller.prototype.rank = original;
    await selector.close();
    store.close();
  }
});

test("advisory context exposes unresolved requirements and public predicate state without expected answers or selection proposals", () => {
  const base = encodeContext(task, observation, []);
  const context = advisoryContext(task, base, observation);
  assert.equal(context.length, 48);
  assert.deepEqual(Array.from(context.slice(36, 44)), Array(8).fill(0));
  assert.deepEqual(
    advisoryContext(
      {
        ...task,
        expected: { result: "Other evaluator answer" },
        parameters: { name: "Other private value" },
      },
      base,
      observation,
    ),
    context,
  );
  assert.notDeepEqual(
    advisoryContext(
      { ...task, unresolved: ["Required field is missing"] },
      base,
      observation,
    ),
    context,
  );
  assert.notDeepEqual(
    advisoryContext(task, base, {
      ...observation,
      facts: { ...observation.facts, closed: true },
    }),
    context,
  );
});

test("conditional advice uses the selected descriptor after scoring and cannot change the selected candidate", async () => {
  const histories: Float32Array[] = [];
  const fakeSession = {
    run: async (feed: any) => {
      histories.push(new Float32Array(feed.history.data));
      return {
        scores: {
          data: Float32Array.from(histories.length === 1 ? [0, 2] : [9, 0]),
        },
        predicates: { data: Float32Array.from([1, 2, 3]) },
        recovery: { data: Float32Array.from([0, 1, 2, 3]) },
        outcome: { data: Float32Array.from([0.7, 0.2]) },
      };
    },
    release: async () => {},
  };
  // Deterministic argument test. Model updates and ONNX parity use the real CPU experiment.
  const controller = new (Controller as any)(fakeSession) as Controller;
  const input = advisoryContext(
    task,
    encodeContext(task, observation, []),
    observation,
  );
  input.fill(9, 36, 44);
  const bank = [
    { descriptor: [1, 0, 0, 0, 0, 0, 0, 0] },
    { descriptor: [0, 1, 0, 0, 0, 0, 0, 0] },
  ];
  const prediction = await controller.rank(observation, bank, input);
  assert.equal(prediction.index, 1);
  assert.deepEqual(Array.from(histories[0].slice(36, 44)), Array(8).fill(0));
  assert.deepEqual(Array.from(histories[1].slice(36, 44)), bank[1].descriptor);
  assert.equal(input[36], 9);
});

test("read-only assessment uses the pinned full-head model and rejects changed contracts or foreign targets", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-assessment-")));
  const selector = new AdaptiveSelector(store);
  const contract = {
    ...task,
    parameters: {},
    unresolved: ["Required name is missing"],
  };
  const originalLoad = Controller.load;
  let loaded = 0,
    closed = 0;
  // This test checks authorization and read-only arguments. It does not attest a model.
  Controller.load = async () => {
    loaded++;
    return {
      rank: async (_observation, bank, history) => {
        assert.deepEqual(bank, [{ descriptor: [0, 0, 0, 1, 0, 0, 0, 0] }]);
        assert.equal(history?.length, 48);
        assert.ok(history![44] > 0);
        return {
          index: 0,
          scores: [1],
          predicates: [2, -2, -2],
          recovery: [-2, -2, -2, 2],
          outcome: [0.4, 0.2],
          latencyMs: 0.1,
        };
      },
      close: async () => {
        closed++;
      },
    } as Controller;
  };
  try {
    store.putRun({
      id: contract.id,
      contract,
      status: "awaiting_input",
      cursor: 0,
      skill: "auto",
      model: "fixed",
      bindings: {},
    });
    assert.equal(
      (await selector.assess(contract, observation)).available,
      false,
    );
    await assert.rejects(
      () =>
        selector.assess(
          { ...contract, parameters: { name: "Injected" } },
          observation,
        ),
      /pinned task contract/,
    );
    await assert.rejects(
      () => selector.assess(contract, { ...observation, host: "other" }),
      /another task target/,
    );
    const path = "models/17/trained.onnx",
      digest = hash(readFileSync(path));
    store.put("models", "full-head-boundary", {
      schemaVersion: 1,
      id: "full-head-boundary",
      hash: digest,
      seed: 17,
      format: "onnx",
      parameters: 10041,
      status: "candidate",
      metrics: { contextVersion: 3 },
    });
    store.put("model-path", "full-head-boundary", path);
    store.putRun({ ...store.run(contract.id), model: "full-head-boundary" });
    assert.equal(
      (await selector.assess(contract, observation)).available,
      false,
    );
    store.put("model-qualifications", digest, {
      qualification: {
        track: "browser",
        contextVersion: 3,
        models: [{ seed: 17, sha256: digest, parameters: 10041 }],
        learnedCapabilities: [
          "selection",
          "predicates",
          "recovery",
          "clarification",
          "outcome_cost",
        ],
      },
    });
    const before = store.events(0, contract.id);
    const result = await selector.assess(contract, observation);
    assert.equal(result.available, true);
    if (result.available) {
      assert.equal(result.model, "full-head-boundary");
      assert.equal(result.advice.clarificationRecommended, true);
      assert.equal(result.forecast.available, false);
      assert.ok(result.advice.predicates.ready > 0.5);
    }
    assert.deepEqual(store.events(0, contract.id), before);
    assert.equal(store.run(contract.id).model, "full-head-boundary");
    assert.equal(store.run(contract.id).status, "awaiting_input");
    assert.equal(loaded, 1);
    assert.equal(closed, 1);
    store.put("models", "full-head-boundary", {
      ...(store.get("models", "full-head-boundary") as object),
      metrics: { contextVersion: 4 },
    });
    assert.equal(
      (await selector.assess(contract, observation)).available,
      false,
    );
    assert.equal(loaded, 1);
  } finally {
    Controller.load = originalLoad;
    await selector.close();
    store.close();
  }
});

test("visual state heads hide public labels, goal tokens, output-key hints and teacher proposals", async () => {
  const context = visualContext(task, encodeContext(task, observation, []));
  assert.equal(context[47], -1);
  assert.deepEqual(Array.from(context.slice(45, 47)), [0, 0]);
  const state = visualStateContext(context);
  assert.deepEqual(Array.from(state.slice(24, 32)), Array(8).fill(0));
  assert.deepEqual(Array.from(state.slice(36, 44)), Array(8).fill(0));
  const histories: Float32Array[] = [];
  const session = {
    run: async (feed: any) => {
      histories.push(new Float32Array(feed.history.data));
      return {
        scores: {
          data: Float32Array.from(histories.length === 1 ? [0, 2] : [9, 0]),
        },
        predicates: {
          data: Float32Array.from(
            histories.length === 3 ? [-4, 4, -4] : [8, 8, 8],
          ),
        },
        recovery: {
          data: Float32Array.from(
            histories.length === 3 ? [0, 0, 4, 0] : [0, 0, 0, 4],
          ),
        },
        outcome: {
          data: Float32Array.from(
            histories.length === 2 ? [0.7, 0.2] : [0.9, 0.9],
          ),
        },
      };
    },
    release: async () => {},
  };
  const controller = new (Controller as any)(session) as Controller;
  const bank = [
    { descriptor: [1, 0, 0, 0, 0, 0, 0, 0] },
    { descriptor: [0, 1, 0, 0, 0, 0, 0, 0] },
  ];
  await assert.rejects(
    () => controller.rank(observation, bank, context),
    /actual captured pixels/,
  );
  const result = await controller.rank(
    observation,
    bank,
    context,
    new Float32Array(3072),
  );
  assert.equal(result.index, 1);
  assert.equal(histories.length, 3);
  assert.deepEqual(Array.from(histories[1].slice(36, 44)), bank[1].descriptor);
  assert.deepEqual(histories[2], state);
  assert.deepEqual(result.predicates, [-4, 4, -4]);
  assert.equal(result.recovery[2], 4);
  assert.deepEqual(result.outcome, Array.from(Float32Array.from([0.7, 0.2])));
});
