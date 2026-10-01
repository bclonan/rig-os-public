import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonical, hash } from "../src/util/canonical.js";
import {
  followupSelectedArtifacts,
  followupSelectedInputResolution,
  followupTrainingProvenance,
  followupTrainingSources,
} from "../src/learner/portable-inputs.js";
import { auditFullHeads } from "../evaluation/learning-followup-v4-audit.js";

// Exact public selected bytes exercise provenance admission only. These tests
// never run inference, train, collect private cases, qualify or activate a model.
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "cur-training-origin-")),
    root = join(parent, "learning-followup-v4"),
    directory = join(root, "browser"),
    origin = join(directory, "training-origin");
  mkdirSync(directory, { recursive: true });
  copyFileSync(
    "evidence/learning-followup-v4/protocol.json",
    join(root, "protocol.json"),
  );
  for (const name of followupSelectedArtifacts) {
    const target = join(directory, ...name.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(
      join("evidence/learning-followup-v4/browser", ...name.split("/")),
      target,
    );
  }
  cpSync("evidence/learning-followup-v4-training-origin-v1", origin, {
    recursive: true,
  });
  const fingerprint = () => ({
    ...Object.fromEntries(
      followupTrainingSources.map((name) => [name, hash(readFileSync(name))]),
    ),
    ...Object.fromEntries(
      followupSelectedInputResolution(directory).map((file) => [
        file.originalPath,
        file.sha256,
      ]),
    ),
    ...Object.fromEntries(
      followupSelectedArtifacts.map((name) => {
        const path = resolve(directory, ...name.split("/"));
        return [path, hash(readFileSync(path))];
      }),
    ),
  });
  return { parent, root, directory, origin, fingerprint };
}

test("portable publication origin binds six read-only sources, three aliases and all22 selected artifacts", () => {
  const f = fixture();
  try {
    const current = f.fingerprint(),
      proof = followupTrainingProvenance(f.directory, current);
    assert.equal(proof.kind, "VERIFIED_PUBLICATION_TRAINING_ORIGIN");
    assert.equal(proof.artifacts.length, 22);
    assert.equal(proof.selectedInputs.length, 3);
    assert.equal(proof.origin?.files.length, 10);
    assert.equal(
      current["learner/followup_v4_train.py"],
      hash(readFileSync("learner/followup_v4_train.py")),
    );
    assert.notEqual(
      current["learner/followup_v4_train.py"],
      proof.trainingSource["learner/followup_v4_train.py"],
    );
    assert.equal(
      proof.origin?.files.find(
        (file) => file.name === "sources/learner/followup_v4_train.py",
      )?.sha256,
      proof.trainingSource["learner/followup_v4_train.py"],
    );
    assert.equal(existsSync(join(f.root, ".evaluator.key")), false);
    assert.equal(existsSync(join(f.directory, "audit-store")), false);
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test("missing historical origin denies before any Store, adapter or model rollout", async () => {
  const f = fixture();
  try {
    rmSync(f.origin, { recursive: true });
    const protocolBytes = readFileSync(join(f.root, "protocol.json"));
    await assert.rejects(
      () =>
        auditFullHeads({
          root: f.root,
          directory: f.directory,
          protocolBytes,
          protocol: JSON.parse(protocolBytes.toString()),
          sourceBefore: f.fingerprint(),
          protectedBefore: {},
          fingerprint: f.fingerprint,
        }),
      /V4 training provenance: verified local origin bundle is required/,
    );
    for (const name of [
      "audit-store",
      "heads.jsonl",
      "episodes.jsonl",
      "results.json",
      "audit-sealed.json",
    ])
      assert.equal(existsSync(join(f.directory, name)), false);
    assert.equal(existsSync(join(f.root, ".evaluator.key")), false);
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

for (const name of [
  "results.json",
  "audit-sealed.json",
  "selection.json",
  "sources/learner/followup_v4_train.py",
  "sources/evaluation/learning-followup-v4.protocol.json",
])
  test("changed historical origin member is rejected: " + name, () => {
    const f = fixture();
    try {
      const path = join(f.origin, ...name.split("/"));
      writeFileSync(
        path,
        Buffer.concat([readFileSync(path), Buffer.from("\n")]),
      );
      assert.throws(
        () => followupTrainingProvenance(f.directory, f.fingerprint()),
        /training provenance/,
      );
    } finally {
      rmSync(f.parent, { recursive: true, force: true });
    }
  });

for (const name of [
  "training.json",
  "program-bank.json",
  "operational.json",
  "conditional-parity.json",
  "models/17/initialized.onnx",
  "models/41/trained.pt",
  "models/73/report.json",
  "models/17/trained.onnx",
])
  test(
    "every selected input/checkpoint is cross-bound to the reviewed origin: " +
      name,
    () => {
      const f = fixture();
      try {
        const path = join(f.directory, ...name.split("/"));
        writeFileSync(
          path,
          Buffer.concat([readFileSync(path), Buffer.from(" ")]),
        );
        assert.throws(
          () => followupTrainingProvenance(f.directory, f.fingerprint()),
          /training provenance|selected input bytes changed/,
        );
      } finally {
        rmSync(f.parent, { recursive: true, force: true });
      }
    },
  );

test("changed selection, omitted/extra source keys and stale current executable fingerprint reject", () => {
  for (const variant of ["selection", "omitted", "extra", "current"] as const) {
    const f = fixture();
    try {
      let source = f.fingerprint();
      if (variant === "current")
        source["learner/followup_v4_train.py"] = "0".repeat(64);
      else {
        const path = join(f.directory, "selection.json"),
          selection = JSON.parse(readFileSync(path, "utf8"));
        if (variant === "selection")
          selection.candidateHashes[0].sha256 = "0".repeat(64);
        else if (variant === "omitted")
          delete selection.trainingSourceAfter["learner/model.py"];
        else selection.trainingSourceAfter["learner/extra.py"] = "0".repeat(64);
        selection.trainingSourceBefore = selection.trainingSourceAfter;
        writeFileSync(path, JSON.stringify(selection));
        source = f.fingerprint();
      }
      assert.throws(
        () => followupTrainingProvenance(f.directory, source),
        /training provenance/,
      );
    } finally {
      rmSync(f.parent, { recursive: true, force: true });
    }
  }
});

test("copied evaluator key, extra/missing manifest members and directory aliases reject", () => {
  for (const variant of [
    "key",
    "extra",
    "missing",
    "root-link",
    "member-link",
  ] as const) {
    const f = fixture();
    try {
      if (variant === "key")
        writeFileSync(join(f.origin, ".evaluator.key"), Buffer.alloc(32));
      if (variant === "extra" || variant === "missing") {
        const path = join(f.origin, "manifest.json"),
          manifest = JSON.parse(readFileSync(path, "utf8"));
        if (variant === "extra")
          manifest.files["../../escape"] = "0".repeat(64);
        else delete manifest.files["selection.json"];
        writeFileSync(path, JSON.stringify(manifest));
      }
      if (variant === "root-link" || variant === "member-link") {
        const path =
            variant === "root-link" ? f.origin : join(f.origin, "sources"),
          outside = join(f.parent, "linked-evidence");
        cpSync(path, outside, { recursive: true });
        rmSync(path, { recursive: true });
        symlinkSync(
          outside,
          path,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      assert.throws(
        () => followupTrainingProvenance(f.directory, f.fingerprint()),
        /training provenance/,
      );
    } finally {
      rmSync(f.parent, { recursive: true, force: true });
    }
  }
});

test("literal current-source preparation stays available without historical remapping", () => {
  const f = fixture();
  try {
    const path = join(f.directory, "selection.json"),
      selection = JSON.parse(readFileSync(path, "utf8"));
    for (const name of followupTrainingSources)
      selection.trainingSourceAfter[name] = hash(readFileSync(name));
    selection.trainingSourceBefore = selection.trainingSourceAfter;
    writeFileSync(path, JSON.stringify(selection));
    rmSync(f.origin, { recursive: true });
    const proof = followupTrainingProvenance(f.directory, f.fingerprint());
    assert.equal(proof.kind, "CURRENT_TRAINING_SOURCE");
    assert.equal("origin" in proof, false);
    assert.equal(
      canonical(proof.trainingSource),
      canonical(selection.trainingSourceAfter),
    );
    // Metadata admission does not attest that this edited test selection was trained.
    assert.equal(existsSync(join(f.directory, "audit-sealed.json")), false);
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test("omitted current alias bindings cannot be repaired by the historical origin", () => {
  const f = fixture();
  try {
    const source = f.fingerprint();
    delete source[followupSelectedInputResolution(f.directory)[0].originalPath];
    assert.throws(
      () => followupTrainingProvenance(f.directory, source),
      /selected aliases/,
    );
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});

test("malformed origin metadata denies with a member-specific provenance error", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.origin, "manifest.json"), "{broken-private-body");
    assert.throws(
      () => followupTrainingProvenance(f.directory, f.fingerprint()),
      (error: any) => {
        assert.equal(
          error.message,
          "V4 training provenance: origin member is not valid JSON: manifest.json",
        );
        assert.equal(error.message.includes("broken-private-body"), false);
        return true;
      },
    );
  } finally {
    rmSync(f.parent, { recursive: true, force: true });
  }
});
