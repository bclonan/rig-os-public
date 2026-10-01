import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, hash, Store } from "../src/storage/index.js";
import { ModelRegistry } from "../src/learner/index.js";
import {
  verifyFollowupAudit,
  validateAdvisoryHeldoutRows,
  recomputeVisualHeadMetrics,
} from "../src/learner/qualification.js";

// These deliberately incomplete audits exercise rejection paths. They never
// qualify a checkpoint and do not fabricate positive execution evidence.
function rejectionFixture(
  mode: "unsigned" | "stale" | "swapped" | "unselected",
) {
  const parent = join(
    mkdtempSync(join(tmpdir(), "cur-followup-rejection-")),
    "learning-followup-v999",
  );
  const directory = join(parent, "native"),
    modelPath = join(directory, "models", "17", "trained.onnx");
  mkdirSync(join(directory, "models", "17"), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(join(parent, ".evaluator.key"), key);
  const source = join(directory, "reviewed-source.txt");
  writeFileSync(source, "reviewed");
  const selectedHash = hash("model-A");
  writeFileSync(modelPath, mode === "swapped" ? "model-B" : "model-A");
  const sourceHashes = {
    [source]: hash(readFileSync(source)),
    [modelPath]: hash(readFileSync(modelPath)),
  };
  const protocol = Buffer.from(
    JSON.stringify({ id: "learning-followup-v999", protected: [] }),
  );
  writeFileSync(join(parent, "protocol.json"), protocol);
  const selection = Buffer.from(
    JSON.stringify({
      status: mode === "unselected" ? "FAIL" : "PASS",
      protocolHash: hash(protocol),
      candidateHashes: [{ seed: 17, sha256: selectedHash }],
    }),
  );
  writeFileSync(join(directory, "selection.json"), selection);
  const report = Buffer.from(
    JSON.stringify({
      protocolHash: hash(protocol),
      sourceStable: true,
      sourceBefore: sourceHashes,
      sourceAfter: sourceHashes,
      protectedBefore: {},
      protectedAfter: {},
      candidateSelectionHash: hash(selection),
      models: [{ seed: 17, sha256: selectedHash }],
    }),
  );
  writeFileSync(join(directory, "results.json"), report);
  const episodes = Buffer.from("{}\n");
  writeFileSync(join(directory, "episodes.jsonl"), episodes);
  const body = {
    protocolHash: hash(protocol),
    resultsHash: hash(report),
    episodesHash: hash(episodes),
    sourceStable: true,
  };
  const signature =
    mode === "unsigned"
      ? "0".repeat(64)
      : createHmac("sha256", key).update(canonical(body)).digest("hex");
  writeFileSync(
    join(directory, "audit-sealed.json"),
    JSON.stringify({ ...body, signature }),
  );
  if (mode === "stale") writeFileSync(source, "changed after evaluation");
  return directory;
}

test("followup promotion rejects unsigned local outcomes", () => {
  assert.throws(
    () => verifyFollowupAudit(rejectionFixture("unsigned")),
    /attestation rejected/,
  );
});

test("visual ablation recomputation rejects visible state hints and missing fixed conditions", () => {
  // Small validator fixture only. Frozen qualification still requires100realcases/seed.
  const normal = { predicates: [0.9, 0.1, 0.1] },
    imageZero = { predicates: [0.1, 0.9, 0.9] };
  const context = Array(48).fill(0);
  context[47] = -1;
  const row = {
    seed: 17,
    context,
    predicateTruth: [1, 0, 0],
    policyUsesPublicStateTruth: false,
    stateForwardGoalHidden: true,
    predictions: { trained: normal },
    ablations: {
      normal,
      image_zero: imageZero,
      context_zero: normal,
      both_zero: imageZero,
    },
  };
  const [metric] = recomputeVisualHeadMetrics([row], [17]);
  assert.equal(metric.normalAccuracy, 1);
  assert.equal(metric.imageZeroAccuracy, 0);
  assert.equal(metric.contextZeroAccuracy, 1);
  assert.deepEqual(metric.imageBenefit95, [1, 1]);
  assert.throws(
    () =>
      recomputeVisualHeadMetrics(
        [{ ...row, policyUsesPublicStateTruth: true }],
        [17],
      ),
    /expose state/,
  );
  assert.throws(
    () =>
      recomputeVisualHeadMetrics(
        [
          {
            ...row,
            context: context.map((value, index) =>
              index === 45 ? 0.5 : value,
            ),
          },
        ],
        [17],
      ),
    /expose state/,
  );
  assert.throws(
    () =>
      recomputeVisualHeadMetrics(
        [
          {
            ...row,
            ablations: { normal, image_zero: imageZero, context_zero: normal },
          },
        ],
        [17],
      ),
    /condition missing/,
  );
});

test("registration cannot change the inference context of an existing model version", () => {
  const root = mkdtempSync(join(tmpdir(), "cur-model-metadata-"));
  const store = new Store(join(root, "store"));
  try {
    const path = join(root, "trained.onnx");
    writeFileSync(path, readFileSync("models/17/trained.onnx"));
    const report = JSON.parse(readFileSync("models/17/report.json", "utf8"));
    const reportPath = join(root, "report.json");
    writeFileSync(reportPath, JSON.stringify(report));
    const registry = new ModelRegistry(store);
    const original = registry.register("pinned", path, 17);
    assert.deepEqual(registry.register("pinned", path, 17), original);
    writeFileSync(reportPath, JSON.stringify({ ...report, contextVersion: 4 }));
    assert.throws(
      () => registry.register("pinned", path, 17),
      /metadata is immutable/,
    );
    assert.deepEqual(registry.list(), [original]);
    writeFileSync(
      reportPath,
      JSON.stringify({ ...report, sha256: "f".repeat(64) }),
    );
    assert.equal(registry.register("other", path, 17).metrics.parity, -1);
  } finally {
    store.close();
  }
});
test("followup promotion rejects current source changes and validation-rejected candidates", () => {
  assert.throws(
    () => verifyFollowupAudit(rejectionFixture("stale")),
    /source is stale/,
  );
  assert.throws(
    () => verifyFollowupAudit(rejectionFixture("unselected")),
    /not selected/,
  );
});
test("followup promotion binds actual evaluated ONNX bytes to the validation-selected checkpoint", () => {
  assert.throws(
    () => verifyFollowupAudit(rejectionFixture("swapped")),
    /differ from the selected checkpoint/,
  );
});

test("full-head attestation rejects malformed masks, dimensions, future truth and selection proposal leakage", () => {
  const prediction = {
    predicates: [0.8, 0.1, 0.1],
    recovery: 3,
    outcome: [0.3, 0.1],
    latencyMs: 1,
  };
  const row = {
    seed: 17,
    episode: 4,
    scenario: 4,
    observationId: "before",
    before: {
      id: "before",
      host: "host",
      session: "session",
      target: "browser-fixture-v1",
      at: 1,
      facts: { ready: true, closed: false, dialog: false },
    },
    contract: {
      target: {
        host: "host",
        session: "session",
        identity: "browser-fixture-v1",
      },
      unresolved: ["Missing typed input"],
      expected: { result: "Answer" },
    },
    runtimeStatus: "awaiting_input",
    context: Array(48).fill(0),
    proposedDescriptor: [0, 0, 0, 1, 0, 0, 0, 0],
    predicateTruth: [1, 0, 0],
    recoveryTruth: 3,
    outcomeTruth: 0,
    costTruth: 0,
    outcomeMask: 0,
    costMask: 0,
    predictions: { trained: prediction, initialized: prediction },
    elapsedMs: 5,
    generativeCalls: 0,
    policyUsesPostActionData: false,
  };
  assert.doesNotThrow(() => validateAdvisoryHeldoutRows([row], 100));
  for (const malformed of [
    { ...row, outcomeMask: "0" },
    { ...row, episode: 100 },
    { ...row, predicateTruth: [1, 0] },
    { ...row, predicateTruth: [0, 0, 0] },
    { ...row, runtimeStatus: "succeeded" },
    {
      ...row,
      context: row.context.map((item, index) => (index === 36 ? 1 : item)),
    },
    {
      ...row,
      predictions: {
        ...row.predictions,
        trained: { ...prediction, recovery: 9 },
      },
    },
    {
      ...row,
      predictions: {
        ...row.predictions,
        trained: { ...prediction, outcome: [Number.NaN, 0] },
      },
    },
  ])
    assert.throws(
      () => validateAdvisoryHeldoutRows([malformed], 100),
      /heldout row/,
    );
});
