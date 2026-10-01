import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { canonical, hash } from "../util/canonical.js";
import { ModelRegistry } from "./index.js";
import { verifyFollowupAudit } from "./qualification.js";
import { Store } from "../storage/index.js";
import {
  followupInputResolution,
  followupTrainingProvenance,
  followupTrainingSources,
  followupSelectedArtifacts,
} from "./portable-inputs.js";
const inputNames = [
  "selection.json",
  "training.json",
  "train-manifest.json",
  "validation-manifest.json",
  "operational.json",
  "conditional-parity.json",
  "program-bank.json",
] as const;
const modelNames = [
  "initialized.onnx",
  "trained.onnx",
  "initialized.pt",
  "trained.pt",
  "report.json",
] as const;

export function prepareFollowupRequalification(
  sourceRoot: string,
  destinationRoot: string,
  originDirectory = resolve("evidence/learning-followup-v4-training-origin-v1"),
) {
  sourceRoot = realpathSync(resolve(sourceRoot));
  destinationRoot = resolve(destinationRoot);
  const segments: string[] = [];
  let ancestor = destinationRoot;
  while (!existsSync(ancestor)) {
    segments.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  destinationRoot = join(realpathSync(ancestor), ...segments);
  const insideSource = relative(sourceRoot, destinationRoot);
  if (
    basename(destinationRoot) !== "learning-followup-v4" ||
    existsSync(destinationRoot) ||
    (insideSource !== ".." &&
      !insideSource.startsWith(".." + sep) &&
      !isAbsolute(insideSource))
  )
    throw new Error(
      "Use a fresh learning-followup-v4 directory outside the original evidence",
    );
  const protocolBytes = readFileSync(join(sourceRoot, "protocol.json")),
    protocol = JSON.parse(protocolBytes.toString()),
    expectedProtocol = readFileSync(
      "evaluation/learning-followup-v4.protocol.json",
    ),
    sourceDirectory = join(sourceRoot, "browser"),
    selection = JSON.parse(
      readFileSync(join(sourceDirectory, "selection.json"), "utf8"),
    ),
    training = JSON.parse(
      readFileSync(join(sourceDirectory, "training.json"), "utf8"),
    );
  if (
    hash(protocolBytes) !== hash(expectedProtocol) ||
    protocol.id !== "learning-followup-v4" ||
    canonical(protocol.seeds) !== canonical([17, 41, 73]) ||
    selection.status !== "PASS" ||
    selection.protocolHash !== hash(protocolBytes) ||
    selection.programBankHash !==
      hash(readFileSync(join(sourceDirectory, "program-bank.json"))) ||
    !Array.isArray(training) ||
    !Array.isArray(selection.candidateHashes)
  )
    throw new Error(
      "Requalification requires the unchanged frozen selected inputs",
    );
  for (const seed of protocol.seeds) {
    const digest = hash(
      readFileSync(
        join(sourceDirectory, "models", String(seed), "trained.onnx"),
      ),
    );
    if (
      !selection.candidateHashes.some(
        (entry: any) => entry.seed === seed && entry.sha256 === digest,
      ) ||
      !training.some(
        (entry: any) => entry.seed === seed && entry.sha256 === digest,
      )
    )
      throw new Error(
        "Selected model changed before requalification preparation",
      );
  }
  const resolution = followupInputResolution(sourceDirectory);
  const trainingProvenance = followupTrainingProvenance(
    sourceDirectory,
    {
      ...Object.fromEntries(
        followupTrainingSources.map((name) => [name, hash(readFileSync(name))]),
      ),
      ...Object.fromEntries(
        resolution.selectedInputs.map((input) => [
          input.originalPath,
          input.sha256,
        ]),
      ),
      ...Object.fromEntries(
        followupSelectedArtifacts.map((name) => {
          const path = realpathSync(join(sourceDirectory, ...name.split("/")));
          return [path, hash(readFileSync(path))];
        }),
      ),
    },
    originDirectory,
  );
  const files = new Map<string, string>([
    ["protocol.json", join(sourceRoot, "protocol.json")],
  ]);
  for (const name of inputNames)
    files.set(join("browser", name), join(sourceDirectory, name));
  for (const seed of protocol.seeds)
    for (const name of modelNames)
      files.set(
        join("browser", "models", String(seed), name),
        join(sourceDirectory, "models", String(seed), name),
      );
  for (const manifest of resolution.manifests)
    for (const image of manifest.images)
      files.set(
        join("browser", manifest.split + "-images", image.sha256 + ".png"),
        image.localImagePath,
      );
  if ("origin" in trainingProvenance)
    for (const file of trainingProvenance.origin.files)
      files.set(
        join("browser", "training-origin", ...file.name.split("/")),
        file.localPath,
      );
  // Validate every source byte before creating a partial destination.
  const inputs = [...files].map(([name, sourcePath]) => {
    const path = realpathSync(sourcePath);
    const originName = relative(join("browser", "training-origin"), name);
    const isOrigin =
      "origin" in trainingProvenance &&
      trainingProvenance.origin.files.some(
        (file) =>
          file.localPath === path &&
          join("browser", "training-origin", ...file.name.split("/")) === name,
      );
    if (
      isOrigin
        ? relative(trainingProvenance.origin!.directory, path) !== originName
        : relative(sourceRoot, path) !== name
    )
      throw new Error(
        "Copied input resolves outside its exact selected source path",
      );
    return { name, path, sha256: hash(readFileSync(path)) };
  });
  mkdirSync(join(destinationRoot, "browser"), { recursive: true });
  for (const input of inputs) {
    const bytes = readFileSync(input.path);
    if (hash(bytes) !== input.sha256)
      throw new Error("Source input changed during preparation");
    const destination = join(destinationRoot, input.name);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes, { flag: "wx" });
    if (hash(readFileSync(destination)) !== input.sha256)
      throw new Error("Copied requalification input changed");
  }
  const result = {
    schemaVersion: 1,
    status: "PREPARED_NOT_QUALIFIED",
    sourceRoot,
    destinationRoot,
    protocolSha256: hash(protocolBytes),
    inputs,
    imageReferencePolicy: resolution.scope,
    trainingProvenance,
    modelSelectionChanged: false,
    manifestsRewritten: false,
    evaluatorKeyCopied: false,
    auditOutputsCopied: false,
    storesCopied: false,
    finalMethod:
      "Same exposed frozen cases and unchanged selected bytes, locally requalified against current maintained source. No new unseen-case generalization claim.",
  };
  writeFileSync(
    join(destinationRoot, "browser", "requalification-inputs.json"),
    JSON.stringify(result, null, 2),
    { flag: "wx" },
  );
  return result;
}

export function installQualifiedFollowup(
  qualifiedRoot: string,
  dataDirectory: string,
  activateSeed?: number,
) {
  const directory = join(resolve(qualifiedRoot), "browser");
  if (basename(resolve(qualifiedRoot)) !== "learning-followup-v4")
    throw new Error("Use the locally qualified V4 browser namespace");
  // Reject missing keys, failed audits and stale source before opening the user's store.
  const qualification = verifyFollowupAudit(directory);
  if (
    qualification.contextVersion !== 4 ||
    qualification.track !== "browser" ||
    qualification.candidateDescriptorVersion !== 2
  )
    throw new Error("This installer requires a qualified V4 browser model");
  if (
    activateSeed !== undefined &&
    !qualification.models.some((model) => model.seed === activateSeed)
  )
    throw new Error("Requested seed is not qualified");
  const store = new Store(resolve(dataDirectory));
  try {
    const registry = new ModelRegistry(store);
    registry.importFollowupAudit(directory);
    const candidates = qualification.models.map((model) => {
      const id =
        "owned-v4-" +
        model.seed +
        "-" +
        model.sha256.slice(0, 12) +
        "-" +
        qualification.resultsHash.slice(0, 12);
      return registry.register(
        id,
        join(directory, "models", String(model.seed), "trained.onnx"),
        model.seed,
      );
    });
    if (activateSeed !== undefined)
      registry.activate(
        candidates.find((candidate) => candidate.seed === activateSeed)!.id,
      );
    return {
      status:
        activateSeed === undefined
          ? "REGISTERED_NOT_ACTIVATED"
          : "ACTIVATED_SCOPED_BROWSER_MODEL",
      dataDirectory: store.root,
      scope: qualification.scope,
      candidates,
      active: store.get<string>("model", "active") || "fixed",
    };
  } finally {
    store.close();
  }
}
