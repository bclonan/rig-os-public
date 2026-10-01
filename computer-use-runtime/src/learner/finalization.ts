import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canonical, hash } from "../util/canonical.js";

export const terminalName = "audit-terminal.json";

// These are exact already-reviewed successful audits, not a namespace exemption.
// Their outer process exits and independent reviews are recorded in the repair
// closure. All ordinary source/model/protocol/metric checks still apply.
export const historicalFollowupAudits = [
  {
    protocol:
      "55229c2fbeb5b0c218e875ef74228f8c7849cc3b99e3e01967491feb1dc7ce3c",
    results: "37f8c47c7df9678a5184145dce37e929317b6c65b2ebbe594d35dcf0feb15867",
    seal: "5a8b77c6d2631232df167f749830212d9b5d79e870e1fdcfd1bd5acd464128a3",
  },
  {
    protocol:
      "55229c2fbeb5b0c218e875ef74228f8c7849cc3b99e3e01967491feb1dc7ce3c",
    results: "7954f911b768ab43ca0968b01ea47d9ec56867cd8a5778fe97e254e082ea3ede",
    seal: "723f317cd2b2875bcc4d5bd5df0f49a94cc5b5acd999cf2b4063f03fae9b8912",
  },
  {
    protocol:
      "55229c2fbeb5b0c218e875ef74228f8c7849cc3b99e3e01967491feb1dc7ce3c",
    results: "4329820e9f16d6ff7bf71e2eb875a94f664a3b26c0f26214db7a9403d9e6e325",
    seal: "6cd6bbd6970005749a5d44e02834ddcb785c8b5fc79d1a7c7ff8927f2cf95ac8",
  },
] as const;

// Flush the complete temporary file before making its immutable name visible.
// linkSync preserves exclusive creation, unlike a rename that replaces a file.
function persist(path: string, bytes: Buffer | string) {
  const temporary = path + ".pending-" + randomUUID();
  let published = false;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    linkSync(temporary, path);
    published = true;
    unlinkSync(temporary);
  } catch (error) {
    const errors = [error];
    // A failed temporary-name cleanup must not leave a promotable terminal.
    // Remove only the name this call created, never an existing outcome.
    for (const owned of [temporary, ...(published ? [path] : [])]) {
      try {
        if (existsSync(owned)) unlinkSync(owned);
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }
    throw new AggregateError(errors, "Audit outcome persistence failed");
  }
}

function flush(path: string) {
  const descriptor = openSync(path, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

type FinalizationConfig = {
  root: string;
  directory: string;
  protocolBytes: Buffer;
  report: Record<string, any>;
  cleanup: () => Promise<void>;
  afterCleanup?: () => void;
};

export async function verifiedFollowupSourceAliases(
  directory: string,
  sourceBefore: Record<string, string>,
  sourceAfter = sourceBefore,
) {
  const resolutionPath = join(directory, "image-resolution.json"),
    aliases = new Map<string, string>();
  if (sourceAfter[resolutionPath] === undefined) return aliases;
  const bytes = readFileSync(resolutionPath),
    resolution = JSON.parse(bytes.toString());
  // Deferred loading avoids an initialization cycle with the historical audit
  // authority table. This resolver never executes historical training files.
  const { followupSelectedInputResolution } =
    await import("./portable-inputs.js");
  const inputs = followupSelectedInputResolution(directory);
  if (
    sourceBefore[resolutionPath] !== hash(bytes) ||
    sourceAfter[resolutionPath] !== hash(bytes) ||
    canonical(resolution.selectedInputs) !== canonical(inputs)
  )
    throw new Error(
      "Audit selected-input alias resolution is not fingerprint-bound",
    );
  for (const input of inputs) {
    if (
      sourceBefore[input.originalPath] !== input.sha256 ||
      sourceAfter[input.originalPath] !== input.sha256 ||
      sourceBefore[input.localPath] !== input.sha256 ||
      sourceAfter[input.localPath] !== input.sha256
    )
      throw new Error(
        "Audit selected-input alias differs from its exact local binding",
      );
    aliases.set(input.originalPath, input.localPath);
  }
  return aliases;
}

export async function finalizeFollowupAudit(config: FinalizationConfig) {
  const { root, directory, protocolBytes, report } = config;
  for (const name of ["results.json", "audit-sealed.json", terminalName])
    if (existsSync(join(directory, name)))
      throw new Error("Audit finalization requires fresh immutable outcomes");
  try {
    await config.cleanup();
    config.afterCleanup?.();
  } catch (error) {
    report.status = "FAIL";
    report.finalization = { status: "FAIL", error: String(error) };
    persist(join(directory, "results.json"), JSON.stringify(report, null, 2));
    persist(
      join(directory, terminalName),
      JSON.stringify({
        schemaVersion: 1,
        status: "FAIL",
        cleanup: "FAIL",
        error: String(error),
      }),
    );
    throw error;
  }
  const protocolHash = hash(protocolBytes);
  if (
    report.status !== "PASS" ||
    report.sourceStable !== true ||
    canonical(report.sourceBefore) !== canonical(report.sourceAfter) ||
    canonical(report.protectedBefore) !== canonical(report.protectedAfter)
  ) {
    report.status = "FAIL";
    persist(join(directory, "results.json"), JSON.stringify(report, null, 2));
    persist(
      join(directory, terminalName),
      JSON.stringify({ schemaVersion: 1, status: "FAIL", cleanup: "PASS" }),
    );
    return;
  }
  // Bind and flush every outcome/input listed by the completed report. The seal
  // cannot be published when a listed outcome is missing, changed or unwritable.
  const aliases = await verifiedFollowupSourceAliases(
    directory,
    report.sourceBefore,
    report.sourceAfter,
  );
  for (const [path, digest] of Object.entries(report.sourceAfter)) {
    if (hash(readFileSync(aliases.get(path) ?? path)) !== digest)
      throw new Error("Audit input changed after cleanup: " + path);
  }
  for (const name of [
    "episodes.jsonl",
    "heads.jsonl",
    "selection.json",
    "operational.json",
    "conditional-parity.json",
    "training.json",
    "program-bank.json",
  ])
    flush(join(directory, name));
  persist(join(directory, "results.json"), JSON.stringify(report, null, 2));
  const keyPath = join(root, ".evaluator.key");
  if (!existsSync(keyPath)) persist(keyPath, randomBytes(32));
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error("Evaluator key must be 32 bytes");
  const body = {
    finalizationVersion: 1,
    protocolHash,
    resultsHash: hash(readFileSync(join(directory, "results.json"))),
    episodesHash: hash(readFileSync(join(directory, "episodes.jsonl"))),
    headsHash: hash(readFileSync(join(directory, "heads.jsonl"))),
    sourceStable: true,
    createdAt: new Date().toISOString(),
  };
  const signed = (value: object) => ({
    ...value,
    signature: createHmac("sha256", key).update(canonical(value)).digest("hex"),
  });
  persist(
    join(directory, "audit-sealed.json"),
    JSON.stringify(signed(body), null, 2),
  );
  // This receipt is the last publication step. A crash or failed write before
  // it leaves a seal that the importer cannot promote.
  const terminal = {
    schemaVersion: 1,
    status: "PASS",
    cleanup: "PASS",
    persistence: "PASS",
    protocolHash,
    resultsHash: body.resultsHash,
    episodesHash: body.episodesHash,
    headsHash: body.headsHash,
    sealHash: hash(readFileSync(join(directory, "audit-sealed.json"))),
    finishedAt: new Date().toISOString(),
  };
  persist(
    join(directory, terminalName),
    JSON.stringify(signed(terminal), null, 2),
  );
}

export function verifyFollowupTerminal(
  directory: string,
  key: Buffer,
  protocolBytes: Buffer,
  resultsBytes: Buffer,
  sealBytes: Buffer,
) {
  const seal = JSON.parse(sealBytes.toString());
  if (seal.finalizationVersion === undefined) {
    if (
      historicalFollowupAudits.some(
        (audit) =>
          audit.protocol === hash(protocolBytes) &&
          audit.results === hash(resultsBytes) &&
          audit.seal === hash(sealBytes),
      )
    )
      return "historical-reviewed";
    throw new Error(
      "Legacy audit has no reviewed successful terminal evidence",
    );
  }
  if (seal.finalizationVersion !== 1)
    throw new Error("Unknown audit finalization version");
  const { signature, ...terminal } = JSON.parse(
    readFileSync(join(directory, terminalName), "utf8"),
  );
  const allowed = [
    "schemaVersion",
    "status",
    "cleanup",
    "persistence",
    "protocolHash",
    "resultsHash",
    "episodesHash",
    "headsHash",
    "sealHash",
    "finishedAt",
  ];
  if (
    Object.keys(terminal).length !== allowed.length ||
    Object.keys(terminal).some((name) => !allowed.includes(name)) ||
    JSON.parse(resultsBytes.toString()).status !== "PASS" ||
    terminal.schemaVersion !== 1 ||
    terminal.status !== "PASS" ||
    terminal.cleanup !== "PASS" ||
    terminal.persistence !== "PASS" ||
    !Number.isFinite(Date.parse(terminal.finishedAt)) ||
    terminal.protocolHash !== hash(protocolBytes) ||
    terminal.resultsHash !== hash(resultsBytes) ||
    terminal.episodesHash !== seal.episodesHash ||
    terminal.headsHash !== seal.headsHash ||
    terminal.sealHash !== hash(sealBytes) ||
    typeof signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    !timingSafeEqual(
      createHmac("sha256", key).update(canonical(terminal)).digest(),
      Buffer.from(signature, "hex"),
    )
  )
    throw new Error("Audit terminal cleanup/persistence evidence rejected");
  return "terminal-v1";
}
