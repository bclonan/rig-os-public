import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { canonical, hash } from "../util/canonical.js";
import { historicalFollowupAudits } from "./finalization.js";

type Split = "train" | "validation";
type ImageRow = {
  image: string;
  sourceImage: string;
  before: { image?: string };
};
const selectedNames = [
  "program-bank.json",
  "train-manifest.json",
  "validation-manifest.json",
] as const;

export const followupTrainingSources = [
  "learner/model.py",
  "learner/model_v4.py",
  "learner/followup_v4_train.py",
  "learner/recorded.py",
  "src/learner/descriptor.ts",
  "evaluation/learning-followup-v4.protocol.json",
] as const;
export const followupSelectedArtifacts = [
  "selection.json",
  "training.json",
  "train-manifest.json",
  "validation-manifest.json",
  "operational.json",
  "conditional-parity.json",
  "program-bank.json",
  ...[17, 41, 73].flatMap((seed) =>
    [
      "initialized.onnx",
      "trained.onnx",
      "initialized.pt",
      "trained.pt",
      "report.json",
    ].map((name) => "models/" + seed + "/" + name),
  ),
] as const;
const originNames = [
  "manifest.json",
  "results.json",
  "audit-sealed.json",
  "selection.json",
  ...followupTrainingSources.map((name) => "sources/" + name),
];
const originScope =
  "Public already-reviewed training provenance. Historical source bytes are read and hashed only; no executable import, evaluator key or new qualification.";

// Publication derivatives supply training provenance only. The terminal
// verifier deliberately retains its original reviewed tuples unchanged.
const publicOriginTuple = {
  protocol: "55229c2fbeb5b0c218e875ef74228f8c7849cc3b99e3e01967491feb1dc7ce3c",
  results: "19c4ba510328b3aeaa958235107c8fe342e99fb74723d9cd778a6cf01baf6610",
  seal: "93e36a6dae077e20ec5975d9c9b92ad18e2ea4760827e3fba5f9c3b1c22652e9",
} as const;
const publicOriginScope =
  "Portable publication derivative of reviewed training metadata. Model and controlled image bytes are unchanged. This derivative is training provenance only, never successful terminal evidence or a new qualification.";

function provenanceError(message: string): never {
  throw new Error("V4 training provenance: " + message);
}
function originJson(bytes: Buffer, name: string): any {
  try {
    return JSON.parse(bytes.toString());
  } catch {
    provenanceError("origin member is not valid JSON: " + name);
  }
}
function exactKeys(value: unknown, keys: readonly string[]) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    canonical(Object.keys(value).sort()) === canonical([...keys].sort())
  );
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function normalized(path: string) {
  return path.replaceAll("\\", "/");
}

// These files are evidence, never imported or executed. Reject aliases before
// realpath erases them, including a junction at the origin directory itself.
function originFile(directory: string, name: string) {
  const root = resolve(directory),
    path = join(root, ...name.split("/"));
  if (normalized(relative(root, path)) !== name)
    provenanceError("origin path escapes its directory");
  let cursor = root;
  for (;;) {
    if (lstatSync(cursor).isSymbolicLink())
      provenanceError("origin directory is a link");
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  cursor = root;
  for (const part of name.split("/")) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink())
      provenanceError("origin member is a link");
  }
  if (realpathSync(path) !== join(realpathSync(root), ...name.split("/")))
    provenanceError("origin member resolves outside its exact path");
  const stat = statSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
    provenanceError("origin member is not a bounded independent file");
  const bytes = readFileSync(path);
  if (bytes.length > 16 * 1024 * 1024)
    provenanceError("origin member exceeds its byte budget");
  return { path: realpathSync(path), bytes };
}

function originInventory(directory: string) {
  const names: string[] = [];
  function visit(folder: string, prefix = "") {
    if (lstatSync(folder).isSymbolicLink())
      provenanceError("origin directory is a link");
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) {
        if (!originNames.some((allowed) => allowed.startsWith(name + "/")))
          provenanceError("unexpected origin directory");
        visit(join(folder, entry.name), name + "/");
      } else names.push(name);
      if (names.length > originNames.length)
        provenanceError("unexpected origin member");
    }
  }
  visit(resolve(directory));
  if (canonical(names.sort()) !== canonical([...originNames].sort()))
    provenanceError(
      "origin member inventory is incomplete or contains extra files",
    );
  return originNames.map((name) => ({ name, ...originFile(directory, name) }));
}

/** Bind unchanged selected artifacts to their actual training origin. Current
 * executable paths always remain literal entries in the audit source map. */
export function followupTrainingProvenance(
  directory: string,
  currentSource: Record<string, string>,
  originDirectory = join(directory, "training-origin"),
) {
  const selectionBytes = localFile(directory, "selection.json").bytes,
    selection = JSON.parse(selectionBytes.toString()),
    selectedInputs = followupSelectedInputResolution(directory),
    source = selection.trainingSourceAfter;
  if (
    selection.status !== "PASS" ||
    !digest(selection.protocolHash) ||
    hash(readFileSync(join(dirname(directory), "protocol.json"))) !==
      selection.protocolHash ||
    currentSource["evaluation/learning-followup-v4.protocol.json"] !==
      selection.protocolHash ||
    followupTrainingSources.some(
      (name) => currentSource[name] !== hash(readFileSync(name)),
    )
  )
    provenanceError(
      "current training source or frozen protocol fingerprint is missing or changed",
    );
  if (
    !exactKeys(source, [
      ...followupTrainingSources,
      ...selectedInputs.map((item) => item.originalPath),
    ]) ||
    Object.values(source).some((value) => !digest(value))
  )
    provenanceError(
      "selected training source keyset is not the exact six sources and three inputs",
    );
  if (
    selectedInputs.some(
      (input) =>
        currentSource[input.originalPath] !== input.sha256 ||
        currentSource[input.localPath] !== input.sha256,
    )
  )
    provenanceError(
      "selected aliases and their local files are not both bound in the current audit fingerprint",
    );
  const artifacts = followupSelectedArtifacts.map((name) => {
    const file = localFile(directory, join(...name.split("/"))),
      sha256 = hash(file.bytes);
    if (currentSource[file.path] !== sha256)
      provenanceError(
        "selected artifact is missing or changed in the current audit fingerprint: " +
          name,
      );
    return { name, localPath: file.path, sha256 };
  });
  const base = {
    schemaVersion: 1,
    selectionHash: hash(selectionBytes),
    trainingSource: source as Record<string, string>,
    selectedInputs,
    artifacts,
  };
  if (
    Object.entries(source).every(
      ([path, sha256]) => currentSource[path] === sha256,
    )
  )
    return { ...base, kind: "CURRENT_TRAINING_SOURCE" as const };

  let members: ReturnType<typeof originInventory>;
  try {
    members = originInventory(originDirectory);
  } catch (error) {
    provenanceError(
      "verified local origin bundle is required: " + String(error),
    );
  }
  const member = (name: string) => members.find((file) => file.name === name)!;
  const resultBytes = member("results.json").bytes,
    sealBytes = member("audit-sealed.json").bytes,
    result = originJson(resultBytes, "results.json"),
    seal = originJson(sealBytes, "audit-sealed.json"),
    manifest = originJson(member("manifest.json").bytes, "manifest.json"),
    tuple =
      historicalFollowupAudits.find(
        (entry) =>
          entry.results === hash(resultBytes) && entry.seal === hash(sealBytes),
      ) ??
      (publicOriginTuple.results === hash(resultBytes) &&
      publicOriginTuple.seal === hash(sealBytes)
        ? publicOriginTuple
        : undefined);
  const publicationDerivative = tuple === publicOriginTuple;
  if (
    !tuple ||
    !exactKeys(manifest, [
      "schemaVersion",
      "id",
      "scope",
      "protocolHash",
      "files",
      "archiveSha256",
    ]) ||
    manifest.schemaVersion !== 1 ||
    manifest.id !== "learning-followup-v4-training-origin-v1" ||
    manifest.scope !==
      (publicationDerivative ? publicOriginScope : originScope) ||
    manifest.protocolHash !== tuple.protocol ||
    !digest(manifest.archiveSha256) ||
    !exactKeys(
      manifest.files,
      originNames.filter((name) => name !== "manifest.json"),
    ) ||
    members.some(
      (file) =>
        file.name !== "manifest.json" &&
        manifest.files[file.name] !== hash(file.bytes),
    )
  )
    provenanceError(
      "origin manifest or already-reviewed result/seal tuple is invalid",
    );
  if (
    result.status !== "PASS" ||
    result.sourceStable !== true ||
    canonical(result.sourceBefore) !== canonical(result.sourceAfter) ||
    result.protocolHash !== tuple.protocol ||
    seal.protocolHash !== tuple.protocol ||
    seal.resultsHash !== tuple.results ||
    seal.sourceStable !== true ||
    selection.protocolHash !== tuple.protocol ||
    hash(member("selection.json").bytes) !== base.selectionHash ||
    result.candidateSelectionHash !== base.selectionHash ||
    hash(
      member("sources/evaluation/learning-followup-v4.protocol.json").bytes,
    ) !== tuple.protocol
  )
    provenanceError(
      "origin does not bind the unchanged local selection and frozen protocol",
    );
  for (const [path, sha256] of Object.entries(source)) {
    if (result.sourceAfter[path] !== sha256)
      provenanceError(
        "origin report does not attest the selected training source",
      );
    if (
      followupTrainingSources.includes(path as any) &&
      hash(member("sources/" + path).bytes) !== sha256
    )
      provenanceError(
        "historical source bytes differ from the selected training source",
      );
  }
  const selectionPaths = Object.keys(result.sourceAfter).filter((path) =>
    normalized(path).endsWith("/learning-followup-v4/browser/selection.json"),
  );
  if (selectionPaths.length !== 1)
    provenanceError("origin artifact namespace is ambiguous");
  const prefix = normalized(selectionPaths[0]).slice(
    0,
    -"selection.json".length,
  );
  const originalArtifacts = artifacts.map((artifact) => {
    const matches = Object.entries(result.sourceAfter).filter(
      ([path]) => normalized(path) === prefix + artifact.name,
    );
    if (matches.length !== 1 || matches[0][1] !== artifact.sha256)
      provenanceError(
        "selected artifact differs from the reviewed origin: " + artifact.name,
      );
    return { ...artifact, originalPath: matches[0][0] };
  });
  const candidates = selection.candidateHashes,
    reports = JSON.parse(
      localFile(directory, "training.json").bytes.toString(),
    );
  if (
    !Array.isArray(candidates) ||
    !Array.isArray(reports) ||
    canonical(candidates.map((item: any) => item.seed).sort()) !==
      canonical([17, 41, 73]) ||
    canonical(reports.map((item: any) => item.seed).sort()) !==
      canonical([17, 41, 73]) ||
    canonical(result.models) !== canonical(reports) ||
    selection.programBankHash !==
      artifacts.find((item) => item.name === "program-bank.json")!.sha256 ||
    [17, 41, 73].some((seed) => {
      const sha256 = artifacts.find(
        (item) => item.name === "models/" + seed + "/trained.onnx",
      )!.sha256;
      return (
        candidates.find((item: any) => item.seed === seed)?.sha256 !== sha256 ||
        reports.find((item: any) => item.seed === seed)?.sha256 !== sha256
      );
    })
  )
    provenanceError(
      "origin selected model, training report or program bank binding changed",
    );
  return {
    ...base,
    kind: publicationDerivative
      ? ("VERIFIED_PUBLICATION_TRAINING_ORIGIN" as const)
      : ("VERIFIED_HISTORICAL_TRAINING_ORIGIN" as const),
    artifacts: originalArtifacts,
    origin: {
      directory: realpathSync(originDirectory),
      protocolHash: tuple.protocol,
      resultsHash: tuple.results,
      sealHash: tuple.seal,
      archiveCitationSha256: manifest.archiveSha256,
      archiveReopenedByResolver: false,
      authority: publicationDerivative
        ? publicOriginScope
        : "Exact already-reviewed result/seal/protocol tuple and rehashed local bytes; the archive digest is descriptive extraction metadata",
      files: members.map((file) => ({
        name: file.name,
        localPath: file.path,
        sha256: hash(file.bytes),
      })),
    },
  };
}

function localFile(directory: string, suffix: string) {
  const root = realpathSync(directory),
    path = realpathSync(join(root, suffix));
  if (relative(root, path) !== suffix)
    throw new Error(
      "Recorded input resolves outside its local controlled directory",
    );
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
    throw new Error("Recorded input exceeds its file or byte budget");
  const bytes = readFileSync(path);
  if (bytes.length > 16 * 1024 * 1024)
    throw new Error("Recorded input exceeds its byte budget");
  return { path, bytes };
}

export function resolveFollowupImage(
  directory: string,
  split: Split,
  row: ImageRow,
) {
  if (
    !row ||
    typeof row.image !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.sourceImage) ||
    row.before?.image !== row.sourceImage ||
    !row.image
      .replaceAll("\\", "/")
      .endsWith("/" + split + "-images/" + row.sourceImage + ".png")
  )
    throw new Error("Recorded BEFORE image reference is not bound to its hash");
  const { path, bytes } = localFile(
    directory,
    join(split + "-images", row.sourceImage + ".png"),
  );
  if (
    hash(bytes) !== row.sourceImage ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("Local recorded BEFORE image bytes changed");
  return {
    originalImagePath: row.image,
    localImagePath: path,
    sha256: row.sourceImage,
    split,
  };
}

export function followupImageResolution(directory: string) {
  return {
    schemaVersion: 1,
    scope:
      "Immutable recorded references resolve only to hash-matched local controlled BEFORE images. No original-workspace fallback.",
    manifests: (["train", "validation"] as const).map((split) => {
      const path = join(directory, split + "-manifest.json"),
        bytes = readFileSync(path),
        manifest = JSON.parse(bytes.toString());
      if (!Array.isArray(manifest.rows))
        throw new Error("Recorded manifest rows are missing");
      return {
        split,
        manifestSha256: hash(bytes),
        images: manifest.rows.map((row: ImageRow) =>
          resolveFollowupImage(directory, split, row),
        ),
      };
    }),
  };
}

export function followupSelectedInputResolution(directory: string) {
  const selection = JSON.parse(
    readFileSync(join(directory, "selection.json"), "utf8"),
  );
  if (
    !selection.trainingSourceAfter ||
    canonical(selection.trainingSourceBefore) !==
      canonical(selection.trainingSourceAfter)
  )
    throw new Error("Selected training source identity changed");
  const selected = Object.entries(selection.trainingSourceAfter).filter(
    ([path]) => isAbsolute(path) || win32.isAbsolute(path),
  );
  if (selected.length !== selectedNames.length)
    throw new Error("Unexpected selected absolute input references");
  return selectedNames.map((name) => {
    const matches = selected.filter(([path]) =>
      path.replaceAll("\\", "/").endsWith("/browser/" + name),
    );
    if (matches.length !== 1)
      throw new Error(
        "Selected input does not identify exactly one local controlled file",
      );
    const [originalPath, digest] = matches[0],
      { path, bytes } = localFile(directory, name);
    if (typeof digest !== "string" || hash(bytes) !== digest)
      throw new Error("Local selected input bytes changed");
    return { originalPath, localPath: path, sha256: digest };
  });
}

export function followupInputResolution(directory: string) {
  return {
    ...followupImageResolution(directory),
    selectedInputs: followupSelectedInputResolution(directory),
  };
}

export function assertFreshFollowupAudit(directory: string) {
  for (const name of [
    "audit-sealed.json",
    "audit-terminal.json",
    "results.json",
    "episodes.jsonl",
    "heads.jsonl",
    "audit-store",
  ]) {
    try {
      statSync(join(directory, name));
    } catch (error: any) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(
      "Use a fresh copy. V4 final or partial outcomes already exist",
    );
  }
}
