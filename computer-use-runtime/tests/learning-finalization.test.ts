import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { canonical, hash, Store } from "../src/storage/index.js";
import { ModelRegistry } from "../src/learner/index.js";
import { verifyFollowupAudit } from "../src/learner/qualification.js";
import {
  finalizeFollowupAudit,
  historicalFollowupAudits,
  terminalName,
  verifyFollowupTerminal,
  verifiedFollowupSourceAliases,
} from "../src/learner/finalization.js";
import { followupSelectedInputResolution } from "../src/learner/portable-inputs.js";
import { trainingPython } from "../src/learner/python.js";

// A complete validator fixture, not empirical training or qualification evidence.
// Existing owned ONNX bytes are copied. Synthetic rows exercise importer math;
// they do not claim new model performance, native effects or learning benefit.
function fixture() {
  const root = join(
    mkdtempSync(join(tmpdir(), "cur-finalization-")),
    "learning-followup-v999",
  );
  const directory = join(root, "browser");
  mkdirSync(directory, { recursive: true });
  const protocol = {
    id: "learning-followup-v999",
    contextVersion: 2,
    protected: [],
    seeds: [17, 41, 73],
    episodesPerMethodPerSeed: 100,
    methods: [
      "trained",
      "initialized",
      "fixed",
      "without_compilation",
      "frozen_context",
    ],
    budgets: {
      steps: 8,
      episodeMs: 15000,
      generativeCalls: 0,
      parameters: 10000000,
    },
    uncertainty: { bootstrapSeed: 90210, bootstrapResamples: 2000 },
  };
  const protocolBytes = Buffer.from(JSON.stringify(protocol));
  writeFileSync(join(root, "protocol.json"), protocolBytes);
  const put = (name: string, data: string | Buffer) => {
    const path = join(directory, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, data);
    return hash(readFileSync(path));
  };
  const train = put("train-manifest.json", "{}"),
    validation = put("validation-manifest.json", "{}");
  const models = protocol.seeds.map((seed) => {
    const bytes = readFileSync(`models/${seed}/trained.onnx`);
    const model = {
      ...JSON.parse(readFileSync(`models/${seed}/report.json`, "utf8")),
      seed,
      sha256: put(`models/${seed}/trained.onnx`, bytes),
      contextVersion: 2,
      reloadMaxError: 0,
      onnxMaxError: 0,
      validationAccuracy: 1,
      parameterUpdateL2: 1,
      policyUsesPostActionData: false,
      trainManifestHash: train,
      validationManifestHash: validation,
    };
    put(`models/${seed}/report.json`, JSON.stringify(model));
    return model;
  });
  const selectionHash = put(
    "selection.json",
    JSON.stringify({
      status: "PASS",
      protocolHash: hash(protocolBytes),
      candidateHashes: models,
    }),
  );
  const operational = {
    selectionSha256: selectionHash,
    device: "CPUExecutionProvider",
    inferencePasses: 1,
    peakProcessRamBytes: 1,
    learnedCapabilities: ["selection"],
    models: models.map((model) => ({
      seed: model.seed,
      sha256: model.sha256,
      samples: 100,
      inferenceMsMedian: 1,
      inferenceMsP95: 1,
    })),
  };
  put("operational.json", JSON.stringify(operational));
  put("conditional-parity.json", "{}");
  put("training.json", JSON.stringify(models));
  put("program-bank.json", "{}");
  put("heads.jsonl", "");
  const records = protocol.seeds.flatMap((seed) =>
    protocol.methods.flatMap((method) =>
      Array.from({ length: 100 }, (_, episode) => ({
        seed,
        method,
        episode,
        success: method !== "initialized",
        falseSuccess: false,
        observations: 3,
        elapsedMs: 1,
        steps: 2,
        generativeCalls: 0,
      })),
    ),
  );
  put(
    "episodes.jsonl",
    records.map((row) => JSON.stringify(row)).join("\n") + "\n",
  );
  const identity = spawnSync(trainingPython(), ["scripts/source-identity.py"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(identity.status, 0, identity.stderr);
  const source: Record<string, string> = Object.fromEntries(
    JSON.parse(identity.stdout).files.map(
      (file: { path: string; sha256: string }) => [file.path, file.sha256],
    ),
  );
  for (const name of [
    "train-manifest.json",
    "validation-manifest.json",
    "operational.json",
    ...models.map((model) => `models/${model.seed}/trained.onnx`),
  ]) {
    const path = join(directory, name);
    source[path] = hash(readFileSync(path));
  }
  const report = {
    status: "PASS",
    id: "validator-only",
    track: "browser",
    scope: "Synthetic validator fixture only",
    protocolHash: hash(protocolBytes),
    sourceStable: true,
    sourceBefore: source,
    sourceAfter: source,
    protectedBefore: {},
    protectedAfter: {},
    candidateSelectionHash: selectionHash,
    models,
    episodes: records.length,
    falseSuccess: 0,
    learningBenefit: "PASS",
    paired: { success95: [1, 1], observations95: [0, 0] },
    skillTemplates: [hash("validator-template")],
    learnedCapabilities: ["selection"],
    operational,
  };
  return { root, directory, protocolBytes, report };
}

test("cleanup failure cannot publish a PASS report, seal, import or activation", async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      finalizeFollowupAudit({
        ...f,
        cleanup: async () => {
          throw new Error("owned cleanup failed");
        },
      }),
    /owned cleanup failed/,
  );
  assert.equal(
    JSON.parse(readFileSync(join(f.directory, "results.json"), "utf8")).status,
    "FAIL",
  );
  assert.equal(existsSync(join(f.directory, "audit-sealed.json")), false);
  const store = new Store(join(f.root, "store"));
  try {
    const registry = new ModelRegistry(store);
    registry.register(
      "candidate",
      join(f.directory, "models/17/trained.onnx"),
      17,
    );
    assert.throws(() => registry.importFollowupAudit(f.directory));
    assert.throws(() => registry.activate("candidate"));
    assert.equal(store.get("model", "active"), undefined);
    assert.equal(store.list("model-qualifications").length, 0);
  } finally {
    store.close();
  }
});

test("complete new qualification imports and activates, then a signed cleanup failure revokes promotion", async () => {
  const f = fixture();
  let cleaned = false;
  await finalizeFollowupAudit({
    ...f,
    cleanup: async () => {
      assert.equal(existsSync(join(f.directory, "results.json")), false);
      assert.equal(existsSync(join(f.directory, "audit-sealed.json")), false);
      cleaned = true;
    },
  });
  assert.equal(cleaned, true);
  const qualified = verifyFollowupAudit(f.directory);
  assert.equal(qualified.contextVersion, 2);
  const store = new Store(join(f.root, "store"));
  try {
    const registry = new ModelRegistry(store);
    registry.register(
      "candidate",
      join(f.directory, "models/17/trained.onnx"),
      17,
    );
    registry.importFollowupAudit(f.directory);
    assert.equal(registry.activate("candidate").status, "active");
    const terminal = JSON.parse(
      readFileSync(join(f.directory, terminalName), "utf8"),
    );
    delete terminal.signature;
    terminal.cleanup = "FAIL";
    const key = readFileSync(join(f.root, ".evaluator.key"));
    writeFileSync(
      join(f.directory, terminalName),
      JSON.stringify({
        ...terminal,
        signature: createHmac("sha256", key)
          .update(canonical(terminal))
          .digest("hex"),
      }),
    );
    assert.throws(
      () => registry.importFollowupAudit(f.directory),
      /terminal cleanup/,
    );
    assert.throws(() => registry.activate("candidate"), /terminal cleanup/);
    assert.equal(store.get("model", "active"), "candidate"); // no mutation on a denied activation
  } finally {
    store.close();
  }
});

test("missing, mismatched or unsigned terminal receipts cannot qualify completed outcomes", async () => {
  for (const variant of [
    "missing",
    "unsigned",
    "wrong-seal",
    "unknown-version",
    "unlisted-legacy",
  ] as const) {
    const f = fixture();
    await finalizeFollowupAudit({ ...f, cleanup: async () => {} });
    const terminalPath = join(f.directory, terminalName);
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8"));
    if (variant === "missing") rmSync(terminalPath);
    if (variant === "unsigned") {
      terminal.signature = "0".repeat(64);
      writeFileSync(terminalPath, JSON.stringify(terminal));
    }
    if (variant === "wrong-seal") {
      terminal.sealHash = "0".repeat(64);
      writeFileSync(terminalPath, JSON.stringify(terminal));
    }
    if (variant === "unknown-version" || variant === "unlisted-legacy") {
      const sealPath = join(f.directory, "audit-sealed.json"),
        seal = JSON.parse(readFileSync(sealPath, "utf8"));
      delete seal.signature;
      if (variant === "unlisted-legacy") delete seal.finalizationVersion;
      else seal.finalizationVersion = 99;
      writeFileSync(
        sealPath,
        JSON.stringify({
          ...seal,
          signature: createHmac(
            "sha256",
            readFileSync(join(f.root, ".evaluator.key")),
          )
            .update(canonical(seal))
            .digest("hex"),
        }),
      );
    }
    assert.throws(
      () => verifyFollowupAudit(f.directory),
      /ENOENT|terminal|finalization|Legacy audit/,
    );
  }
});

test("outcome persistence failure and a failed final receipt stay non-promotable", async () => {
  for (const variant of ["missing-outcome", "terminal-write"] as const) {
    const f = fixture();
    if (variant === "missing-outcome") rmSync(join(f.directory, "heads.jsonl"));
    await assert.rejects(() =>
      finalizeFollowupAudit({
        ...f,
        cleanup: async () => {},
        afterCleanup: () => {
          if (variant === "terminal-write")
            mkdirSync(join(f.directory, terminalName));
        },
      }),
    );
    assert.throws(() => verifyFollowupAudit(f.directory));
    if (variant === "missing-outcome")
      assert.equal(existsSync(join(f.directory, "audit-sealed.json")), false);
  }
});

test("portable publication reports cannot use the historical terminal exception", () => {
  const directory = "evidence/learning-followup-v4/browser";
  const bytes = [
    readFileSync("evidence/learning-followup-v4/protocol.json"),
    readFileSync(join(directory, "results.json")),
    readFileSync(join(directory, "audit-sealed.json")),
  ];
  assert.equal(historicalFollowupAudits.length, 3);
  assert.throws(
    () =>
      verifyFollowupTerminal(
        directory,
        Buffer.alloc(32),
        bytes[0],
        bytes[1],
        bytes[2],
      ),
    /Legacy audit/,
  );
  assert.throws(
    () =>
      verifyFollowupTerminal(
        directory,
        Buffer.alloc(32),
        bytes[0],
        Buffer.concat([bytes[1], Buffer.from(" ")]),
        bytes[2],
      ),
    /Legacy audit/,
  );
  assert.deepEqual(readFileSync(join(directory, "results.json")), bytes[1]);
});

function aliasTerminalFixture() {
  const parent = mkdtempSync(join(tmpdir(), "cur-portable-terminal-")),
    root = join(parent, "learning-followup-v4"),
    directory = join(root, "browser");
  mkdirSync(directory, { recursive: true });
  const original =
      "C:\\nonexistent-original-audit-" +
      parent.split(/[\\/]/).at(-1) +
      "\\learning-followup-v4\\browser\\",
    source: Record<string, string> = {};
  const trainingSource: Record<string, string> = {};
  for (const name of [
    "program-bank.json",
    "train-manifest.json",
    "validation-manifest.json",
  ]) {
    const local = join(directory, name);
    writeFileSync(local, "{}");
    const sha256 = hash(readFileSync(local));
    source[local] = sha256;
    source[original + name] = sha256;
    trainingSource[original + name] = sha256;
    assert.equal(existsSync(original + name), false);
  }
  writeFileSync(
    join(directory, "selection.json"),
    JSON.stringify({
      trainingSourceBefore: trainingSource,
      trainingSourceAfter: trainingSource,
    }),
  );
  const inputs = followupSelectedInputResolution(directory),
    resolutionPath = join(directory, "image-resolution.json");
  writeFileSync(resolutionPath, JSON.stringify({ selectedInputs: inputs }));
  source[resolutionPath] = hash(readFileSync(resolutionPath));
  for (const name of [
    "episodes.jsonl",
    "heads.jsonl",
    "operational.json",
    "conditional-parity.json",
    "training.json",
  ])
    writeFileSync(join(directory, name), "");
  const protocolBytes = Buffer.from("{}"),
    report = {
      status: "PASS",
      scope:
        "Metadata-only terminal publication test, no performance or qualification claims",
      sourceStable: true,
      sourceBefore: source,
      sourceAfter: source,
      protectedBefore: {},
      protectedAfter: {},
    };
  return {
    parent,
    root,
    directory,
    protocolBytes,
    report,
    resolutionPath,
    inputs,
  };
}

test("metadata terminal finalizes exact local selected aliases without the original workspace", async () => {
  const f = aliasTerminalFixture();
  try {
    await finalizeFollowupAudit({ ...f, cleanup: async () => {} });
    assert.equal(
      verifyFollowupTerminal(
        f.directory,
        readFileSync(join(f.root, ".evaluator.key")),
        f.protocolBytes,
        readFileSync(join(f.directory, "results.json")),
        readFileSync(join(f.directory, "audit-sealed.json")),
      ),
      "terminal-v1",
    );
    // A persisted terminal alone supplies no model, metric or promotion authority.
    assert.throws(() => verifyFollowupAudit(f.directory));
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test("alias preflight denies forged/current-source aliases and mismatched local bindings", async () => {
  for (const variant of [
    "forged-current-source",
    "mismatched-map",
    "unbound-resolution",
    "unlisted-absolute",
  ] as const) {
    const f = aliasTerminalFixture();
    try {
      if (variant === "forged-current-source") {
        const resolution = JSON.parse(readFileSync(f.resolutionPath, "utf8"));
        resolution.selectedInputs[0].originalPath = "learner/model.py";
        writeFileSync(f.resolutionPath, JSON.stringify(resolution));
        f.report.sourceBefore[f.resolutionPath] = hash(
          readFileSync(f.resolutionPath),
        );
      }
      if (variant === "mismatched-map")
        f.report.sourceBefore[f.inputs[0].localPath] = "0".repeat(64);
      if (variant === "unbound-resolution")
        f.report.sourceBefore[f.resolutionPath] = "0".repeat(64);
      if (variant === "unlisted-absolute")
        f.report.sourceBefore[
          "C:\\nonexistent-unlisted-authority\\permission.ts"
        ] = "0".repeat(64);
      if (variant !== "unlisted-absolute")
        await assert.rejects(
          () =>
            verifiedFollowupSourceAliases(f.directory, f.report.sourceBefore),
          /alias/,
        );
      await assert.rejects(() =>
        finalizeFollowupAudit({ ...f, cleanup: async () => {} }),
      );
      assert.equal(existsSync(join(f.directory, "audit-sealed.json")), false);
      assert.equal(existsSync(join(f.directory, terminalName)), false);
    } finally {
      rmSync(f.parent, { recursive: true, force: true });
    }
  }
});
