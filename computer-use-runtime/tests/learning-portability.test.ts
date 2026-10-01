import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonical, hash } from "../src/util/canonical.js";
import {
  assertFreshFollowupAudit,
  followupInputResolution,
  followupSelectedInputResolution,
  followupTrainingSources,
  resolveFollowupImage,
} from "../src/learner/portable-inputs.js";
import {
  installQualifiedFollowup,
  prepareFollowupRequalification,
} from "../src/learner/requalification.js";
import { verifyFollowupAudit } from "../src/learner/qualification.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==",
  "base64",
);
function fixture() {
  const parent = mkdtempSync(join(tmpdir(), "cur-portable-learning-")),
    root = join(parent, "original", "learning-followup-v4"),
    directory = join(root, "browser"),
    destination = join(parent, "fresh", "learning-followup-v4"),
    imageHash = hash(png),
    originalDirectory =
      "C:\\nonexistent-original-workspace\\evidence\\learning-followup-v4\\browser";
  mkdirSync(directory, { recursive: true });
  const protocolBytes = readFileSync(
    "evaluation/learning-followup-v4.protocol.json",
  );
  writeFileSync(join(root, "protocol.json"), protocolBytes);
  const row = (split: string) => ({
    image: originalDirectory + "\\" + split + "-images\\" + imageHash + ".png",
    sourceImage: imageHash,
    before: { image: imageHash },
  });
  for (const split of ["train", "validation"]) {
    writeFileSync(
      join(directory, split + "-manifest.json"),
      JSON.stringify({ rows: [row(split)] }),
    );
    mkdirSync(join(directory, split + "-images"));
    writeFileSync(join(directory, split + "-images", imageHash + ".png"), png);
  }
  writeFileSync(join(directory, "program-bank.json"), "{}");
  const source = {
    ...Object.fromEntries(
      followupTrainingSources.map((name) => [name, hash(readFileSync(name))]),
    ),
    ...Object.fromEntries(
      [
        "program-bank.json",
        "train-manifest.json",
        "validation-manifest.json",
      ].map((name) => [
        originalDirectory + "\\" + name,
        hash(readFileSync(join(directory, name))),
      ]),
    ),
  };
  const reports = [17, 41, 73].map((seed) => {
    const folder = join(directory, "models", String(seed));
    mkdirSync(folder, { recursive: true });
    // Metadata-only inputs test copying. These bytes are not a trained or qualified model.
    for (const name of [
      "initialized.onnx",
      "trained.onnx",
      "initialized.pt",
      "trained.pt",
    ])
      writeFileSync(
        join(folder, name),
        "unqualified-copy-fixture-" + seed + "-" + name,
      );
    const report = {
      seed,
      sha256: hash(readFileSync(join(folder, "trained.onnx"))),
    };
    writeFileSync(join(folder, "report.json"), JSON.stringify(report));
    return report;
  });
  writeFileSync(join(directory, "training.json"), JSON.stringify(reports));
  writeFileSync(
    join(directory, "selection.json"),
    JSON.stringify({
      status: "PASS",
      protocolHash: hash(protocolBytes),
      programBankHash: hash(readFileSync(join(directory, "program-bank.json"))),
      candidateHashes: reports,
      trainingSourceBefore: source,
      trainingSourceAfter: source,
    }),
  );
  for (const name of ["operational.json", "conditional-parity.json"])
    writeFileSync(join(directory, name), "{}");
  return { parent, root, directory, destination, row, imageHash };
}

test("preparation copies exact selected inputs and local BEFORE images without authority or audit outputs", () => {
  const f = fixture();
  writeFileSync(join(f.root, ".evaluator.key"), Buffer.alloc(32, 7));
  for (const name of [
    "results.json",
    "audit-sealed.json",
    "heads.jsonl",
    "episodes.jsonl",
  ])
    writeFileSync(join(f.directory, name), "private-original");
  mkdirSync(join(f.directory, "audit-store"));
  writeFileSync(
    join(f.directory, "audit-store", "runtime.sqlite"),
    "private-store",
  );
  const originals = Object.fromEntries(
    readdirSync(f.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => [name, hash(readFileSync(join(f.directory, name)))]),
  );
  const receipt = prepareFollowupRequalification(f.root, f.destination);
  assert.equal(receipt.status, "PREPARED_NOT_QUALIFIED");
  assert.equal(receipt.modelSelectionChanged, false);
  for (const input of receipt.inputs)
    assert.deepEqual(
      readFileSync(join(f.destination, input.name)),
      readFileSync(input.path),
    );
  for (const [name, digest] of Object.entries(originals))
    assert.equal(hash(readFileSync(join(f.directory, name))), digest);
  assert.equal(existsSync(join(f.destination, ".evaluator.key")), false);
  for (const name of [
    "results.json",
    "audit-sealed.json",
    "heads.jsonl",
    "episodes.jsonl",
    "audit-store",
  ])
    assert.equal(existsSync(join(f.destination, "browser", name)), false);
  assert.deepEqual(
    followupInputResolution(join(f.destination, "browser")).manifests[0]
      .images[0].sha256,
    f.imageHash,
  );
  assert.throws(
    () => prepareFollowupRequalification(f.root, f.destination),
    /fresh/,
  );
});

test("BEFORE resolution never falls back to an original workspace image", () => {
  const f = fixture(),
    original = join(f.parent, "legacy", "train-images", f.imageHash + ".png");
  mkdirSync(join(f.parent, "legacy", "train-images"), { recursive: true });
  writeFileSync(original, png);
  rmSync(join(f.directory, "train-images", f.imageHash + ".png"));
  assert.throws(
    () =>
      resolveFollowupImage(f.directory, "train", {
        ...f.row("train"),
        image: original,
      }),
    /ENOENT/,
  );
  assert.throws(
    () => prepareFollowupRequalification(f.root, f.destination),
    /ENOENT/,
  );
  assert.equal(existsSync(f.destination), false);
});

test("changed BEFORE bytes, hash mismatch and split escape are rejected", () => {
  const f = fixture(),
    row = f.row("train");
  assert.throws(
    () =>
      resolveFollowupImage(f.directory, "train", {
        ...row,
        before: { image: "0".repeat(64) },
      }),
    /bound/,
  );
  assert.throws(
    () => resolveFollowupImage(f.directory, "validation", row),
    /bound/,
  );
  writeFileSync(
    join(f.directory, "train-images", f.imageHash + ".png"),
    "changed",
  );
  assert.throws(
    () => resolveFollowupImage(f.directory, "train", row),
    /bytes changed/,
  );
  assert.throws(
    () => prepareFollowupRequalification(f.root, f.destination),
    /bytes changed/,
  );
  assert.equal(existsSync(f.destination), false);
});

test("a junction cannot resolve a controlled image outside its local split", () => {
  const f = fixture(),
    external = join(f.parent, "external-images");
  mkdirSync(external);
  writeFileSync(join(external, f.imageHash + ".png"), png);
  rmSync(join(f.directory, "train-images"), { recursive: true });
  symlinkSync(
    external,
    join(f.directory, "train-images"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => resolveFollowupImage(f.directory, "train", f.row("train")),
    /outside/,
  );
});

test("preparation rejects a destination junction into original evidence and escaped selected files", () => {
  const f = fixture(),
    alias = join(f.parent, "source-alias");
  symlinkSync(f.root, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () =>
      prepareFollowupRequalification(
        f.root,
        join(alias, "nested", "learning-followup-v4"),
      ),
    /outside the original/,
  );
  assert.equal(existsSync(join(f.root, "nested")), false);
  const external = join(f.parent, "external-models"),
    folder = join(f.directory, "models", "17");
  mkdirSync(external);
  for (const name of readdirSync(folder)) {
    writeFileSync(join(external, name), readFileSync(join(folder, name)));
    rmSync(join(folder, name));
  }
  rmdirSync(folder);
  symlinkSync(
    external,
    folder,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => prepareFollowupRequalification(f.root, f.destination),
    /exact selected source path|outside its local controlled directory/,
  );
  assert.equal(existsSync(f.destination), false);
});

test("only three exact frozen selected input names can resolve locally", () => {
  const f = fixture();
  const resolution = followupSelectedInputResolution(f.directory);
  assert.equal(resolution.length, 3);
  for (const input of resolution) {
    assert.equal(hash(readFileSync(input.localPath)), input.sha256);
    assert.equal(existsSync(input.originalPath), false);
  }
  const path = join(f.directory, "selection.json"),
    selection = JSON.parse(readFileSync(path, "utf8"));
  const first = Object.keys(selection.trainingSourceAfter)[0];
  selection.trainingSourceBefore = selection.trainingSourceAfter = {
    ...selection.trainingSourceAfter,
    "C:\\old\\src\\runtime\\index.ts": selection.trainingSourceAfter[first],
  };
  writeFileSync(path, JSON.stringify(selection));
  assert.throws(
    () => followupSelectedInputResolution(f.directory),
    /Unexpected/,
  );
});

test("changed selected bank or manifest and selected checkpoint fail before creating a destination", () => {
  for (const name of [
    "program-bank.json",
    "train-manifest.json",
    "validation-manifest.json",
    "models/17/trained.onnx",
  ]) {
    const f = fixture();
    writeFileSync(join(f.directory, name), "changed");
    assert.throws(
      () => prepareFollowupRequalification(f.root, f.destination),
      /changed|unchanged/,
    );
    assert.equal(existsSync(f.destination), false);
  }
});

test("sealed and partial audits refuse restart before writing any portability metadata", () => {
  for (const name of [
    "results.json",
    "audit-sealed.json",
    "audit-terminal.json",
    "episodes.jsonl",
    "heads.jsonl",
    "audit-store",
  ]) {
    const f = fixture();
    writeFileSync(join(f.directory, name), "existing-outcome");
    assert.throws(() => assertFreshFollowupAudit(f.directory), /fresh copy/);
    assert.equal(existsSync(join(f.directory, "image-resolution.json")), false);
  }
});

function negativeAttestation(
  f: ReturnType<typeof fixture>,
  transform: (report: any, resolution: any) => void,
) {
  const protocol = JSON.parse(
      readFileSync(join(f.root, "protocol.json"), "utf8"),
    ),
    resolution = followupInputResolution(f.directory),
    report: any = {
      protocolHash: hash(readFileSync(join(f.root, "protocol.json"))),
      sourceStable: true,
      sourceBefore: {},
      sourceAfter: {},
      protectedBefore: {},
      protectedAfter: {},
    };
  for (const input of resolution.selectedInputs) {
    report.sourceBefore[input.originalPath] = input.sha256;
    report.sourceBefore[input.localPath] = input.sha256;
  }
  const resolutionPath = join(f.directory, "image-resolution.json");
  transform(report, resolution);
  const resolutionBytes = JSON.stringify(resolution);
  writeFileSync(resolutionPath, resolutionBytes);
  report.sourceBefore[resolutionPath] = hash(resolutionBytes);
  report.sourceAfter = { ...report.sourceBefore };
  const resultBytes = JSON.stringify(report),
    episodesBytes = "{}\n",
    key = Buffer.alloc(32, 9);
  writeFileSync(join(f.directory, "results.json"), resultBytes);
  writeFileSync(join(f.directory, "episodes.jsonl"), episodesBytes);
  const body = {
    protocolHash: hash(readFileSync(join(f.root, "protocol.json"))),
    resultsHash: hash(resultBytes),
    episodesHash: hash(episodesBytes),
    sourceStable: true,
  };
  writeFileSync(join(f.root, ".evaluator.key"), key);
  writeFileSync(
    join(f.directory, "audit-sealed.json"),
    JSON.stringify({
      ...body,
      signature: createHmac("sha256", key)
        .update(canonical(body))
        .digest("hex"),
    }),
  );
  // No fake positive audit is created. This signed test input must fail before any metrics can qualify.
  return protocol;
}

test("signed forged aliases and unbound local paths cannot bypass literal source checks", () => {
  const f = fixture();
  negativeAttestation(f, (_report, resolution) => {
    resolution.selectedInputs[0].originalPath =
      "C:\\old\\src\\runtime\\index.ts";
  });
  assert.throws(
    () => verifyFollowupAudit(f.directory),
    /resolution is not bound/,
  );
  const second = fixture();
  negativeAttestation(second, (report, resolution) => {
    delete report.sourceBefore[resolution.selectedInputs[0].localPath];
  });
  assert.throws(
    () => verifyFollowupAudit(second.directory),
    /alias is not bound/,
  );
});

test("missing key, failed local audit and stale maintained source never open the chosen data store", () => {
  for (const kind of ["missing-key", "failed-audit", "stale-source"]) {
    const f = fixture(),
      data = join(f.parent, "chosen-data"),
      literal = join(f.parent, "maintained-source.ts");
    writeFileSync(literal, "original");
    negativeAttestation(f, (report) => {
      if (kind === "failed-audit") report.sourceStable = false;
      if (kind === "stale-source")
        report.sourceBefore[literal] = hash(readFileSync(literal));
    });
    if (kind === "missing-key") rmSync(join(f.root, ".evaluator.key"));
    if (kind === "stale-source") writeFileSync(literal, "changed");
    assert.throws(
      () => installQualifiedFollowup(f.root, data, 17),
      kind === "missing-key"
        ? /ENOENT/
        : kind === "failed-audit"
          ? /stable source/
          : /source is stale/,
    );
    assert.equal(existsSync(data), false);
  }
});

test("key, report and selection tampering refuse installation without claiming a qualified model", () => {
  for (const kind of ["key", "report", "selection"]) {
    const f = fixture(),
      data = join(f.parent, "chosen-data");
    negativeAttestation(f, () => {});
    if (kind === "key")
      writeFileSync(join(f.root, ".evaluator.key"), Buffer.alloc(32, 1));
    if (kind === "report")
      writeFileSync(join(f.directory, "results.json"), "{}");
    if (kind === "selection")
      writeFileSync(join(f.directory, "selection.json"), "{}");
    assert.throws(
      () => installQualifiedFollowup(f.root, data),
      /attestation rejected|audit bytes changed|training source identity changed/,
    );
    assert.equal(existsSync(data), false);
  }
});
