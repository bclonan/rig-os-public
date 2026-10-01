import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawnSync } from "node:child_process";
import { canonical, hash } from "../util/canonical.js";

const sourceTrees = [
  "src",
  "console",
  "tests",
  "scripts",
  "evaluation",
  "native/src",
  "native/unix",
  "native/bin",
  ".github",
  "learner",
  "sdk",
  "examples",
  "fixtures",
  "docs/completion-contract-v1",
];
const configuration = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.console.json",
  "vite.config.ts",
  ".prettierrc.json",
  ".prettierignore",
  ".gitattributes",
  ".gitignore",
  "native/Cargo.toml",
  "native/Cargo.lock",
  "REQUEST.md",
  "acceptance.json",
];
const originalEvidence = [
  "audit-sealed.json",
  "results.json",
  "episodes.jsonl",
  "training.json",
  "protocol.sha256",
  "dataset-bundle.json",
  "corrected-dataset-bundle.json",
];
export const candidateSources = [
  "model.py",
  "train.py",
  "generate.py",
  "recorded.py",
];
export const requiredAuthority = [
  "acceptance.json",
  "REQUEST.md",
  "src/runtime/policy.ts",
  "src/learner/qualification.ts",
  "src/learner/index.ts",
  "evaluation/audit.ts",
  "evaluation/learning-followup-v4-audit.ts",
  "evaluation/learning-followup-v4.protocol.json",
  "docs/completion-contract-v1/manifest.json",
  "docs/completion-contract-v1/tasks.json",
  "evidence/audit-sealed.json",
  "evidence/results.json",
  "evidence/episodes.jsonl",
];
const hashPattern = /^[a-f0-9]{64}$/;
// The native filesystem call restores actual Windows casing; the JS realpath implementation does not.
const canonicalPath = realpathSync.native;
type Digests = Record<string, string>;
type Manifest = {
  schemaVersion: 2;
  path: string;
  protected: Digests;
  sourceHashes: Digests;
};

function within(parent: string, path: string) {
  const name = relative(parent, path);
  return (
    name === "" ||
    (!isAbsolute(name) && name !== ".." && !name.startsWith(".." + sep))
  );
}

/** Candidate files cannot alias other files. Trusted Cargo artifacts can have build hard links. */
function checkedPath(root: string, path: string, cargoArtifact = false) {
  if (!within(root, path)) throw new Error("Candidate path escapes workspace");
  let cursor = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    if (
      stat.isSymbolicLink() ||
      (stat.isFile() && stat.nlink > 1 && !cargoArtifact) ||
      !within(root, canonicalPath(cursor))
    )
      throw new Error(
        "Linked path escapes protected ownership: " + relative(root, cursor),
      );
  }
  return path;
}

function files(
  root: string,
  folder: string,
  authority = false,
  skipCaches = false,
): string[] {
  if (!existsSync(folder)) return [];
  checkedPath(root, folder);
  const found: string[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = checkedPath(root, join(folder, entry.name));
    if (skipCaches && entry.name === "__pycache__") continue;
    if (
      authority &&
      (entry.name === "invalidated-attempts" ||
        entry.name === "wrappers" ||
        entry.name === "report-integration-prechange" ||
        entry.name === ".data" ||
        /(?:^|-)store$/.test(entry.name))
    )
      continue;
    if (entry.isDirectory())
      found.push(...files(root, path, authority, skipCaches));
    else if (
      entry.isFile() &&
      (!authority || !/\.(?:log|lock|sqlite(?:-wal|-shm)?)$/.test(entry.name))
    )
      found.push(path);
    else if (!entry.isFile())
      throw new Error("Unsupported protected file type: " + path);
  }
  return found;
}

/** Scientific authority is separate from mutable completion/review logs and runtime Stores. */
export function protectedInventory(requestedRoot: string): Digests {
  const root = canonicalPath(requestedRoot),
    paths = new Set<string>();
  for (const name of [...sourceTrees, "models", "datasets"])
    for (const path of files(root, join(root, name), false, true))
      paths.add(path);
  for (const name of configuration)
    if (existsSync(join(root, name)))
      paths.add(checkedPath(root, join(root, name)));
  for (const name of originalEvidence)
    if (existsSync(join(root, "evidence", name)))
      paths.add(checkedPath(root, join(root, "evidence", name)));
  const release = join(root, "native/target/release");
  if (existsSync(release)) {
    checkedPath(root, release);
    for (const entry of readdirSync(release, { withFileTypes: true }))
      if (
        /\.(?:exe|dll|so(?:\.\d+)*|dylib)$/i.test(entry.name) ||
        !entry.name.includes(".")
      ) {
        const path = checkedPath(root, join(release, entry.name), true);
        if (entry.isFile()) paths.add(path);
        else if (!entry.isDirectory())
          throw new Error("Unsupported protected executable: " + path);
      }
  }
  if (existsSync(join(root, "evidence")))
    for (const entry of readdirSync(join(root, "evidence"), {
      withFileTypes: true,
    })) {
      if (
        /^learning-followup-(?:v\d+|library-v\d+)$/.test(entry.name) ||
        entry.name === "learning-followup-v4-training-origin-v1" ||
        entry.name === "portable-audit"
      )
        for (const path of files(
          root,
          join(root, "evidence", entry.name),
          true,
          true,
        ))
          paths.add(path);
    }
  for (const name of requiredAuthority)
    if (!paths.has(join(root, name)))
      throw new Error("Missing required protected file: " + name);
  return Object.fromEntries(
    [...paths]
      .sort()
      .map((path) => [
        relative(root, path).split(sep).join("/"),
        hash(readFileSync(path)),
      ]),
  );
}

function digests(value: unknown): value is Digests {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([name, digest]) =>
        name !== "__proto__" &&
        typeof digest === "string" &&
        hashPattern.test(digest),
    )
  );
}

function parseManifest(path: string): Manifest {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    value?.schemaVersion !== 2 ||
    typeof value.path !== "string" ||
    !digests(value.protected) ||
    !digests(value.sourceHashes)
  )
    throw new Error(
      "Candidate has no supported trusted prepare receipt; prepare a fresh candidate",
    );
  if (
    canonical(Object.keys(value.sourceHashes).sort()) !==
    canonical([...candidateSources].sort())
  )
    throw new Error("Candidate source inventory changed");
  return value;
}

export function prepareCandidate(
  requestedRoot: string,
  id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID(),
) {
  const root = canonicalPath(requestedRoot);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))
    throw new Error("Invalid candidate identifier");
  const requestedBase = join(root, ".candidates");
  mkdirSync(requestedBase, { recursive: true });
  const base = canonicalPath(checkedPath(root, requestedBase));
  const path = join(base, id),
    receipts = join(base, ".protected");
  if (existsSync(path) || existsSync(join(receipts, id + ".json")))
    throw new Error("Candidate already exists");
  const protectedFiles = protectedInventory(root);
  mkdirSync(receipts, { recursive: true });
  checkedPath(root, receipts);
  for (const name of [
    "learner",
    "models",
    "datasets",
    "evidence",
    "runtime-check",
    "cache",
    "tmp",
  ])
    mkdirSync(join(path, name), { recursive: true });
  for (const name of candidateSources)
    copyFileSync(join(root, "learner", name), join(path, "learner", name));
  const manifest = {
    schemaVersion: 2,
    path,
    protected: protectedFiles,
    sourceHashes: Object.fromEntries(
      candidateSources.map((name) => [
        name,
        hash(readFileSync(join(path, "learner", name))),
      ]),
    ),
    execution:
      "Separate process for trusted development, not an OS security sandbox",
    activation: "Not performed; requires a separate independent sealed audit",
  };
  const bytes = JSON.stringify(manifest, null, 2);
  writeFileSync(join(receipts, id + ".json"), bytes, { flag: "wx" });
  writeFileSync(join(path, "candidate.json"), bytes, { flag: "wx" });
  return path;
}

export class CandidateGuard {
  readonly root: string;
  readonly path: string;
  readonly receiptPath: string;
  private readonly receiptBytes: Buffer;
  readonly manifest: Manifest;
  constructor(root: string, requested: string) {
    this.root = canonicalPath(root);
    const base = canonicalPath(
        checkedPath(this.root, join(this.root, ".candidates")),
      ),
      path = canonicalPath(
        checkedPath(this.root, resolve(this.root, requested)),
      );
    if (
      dirname(path) !== base ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(basename(path))
    )
      throw new Error("Candidate path escapes workspace");
    this.path = checkedPath(this.root, path);
    this.receiptPath = checkedPath(
      this.root,
      join(base, ".protected", basename(path) + ".json"),
    );
    this.receiptBytes = readFileSync(this.receiptPath);
    this.manifest = parseManifest(this.receiptPath);
    this.verify();
  }
  verify() {
    checkedPath(this.root, this.receiptPath);
    if (!this.receiptBytes.equals(readFileSync(this.receiptPath)))
      throw new Error("Trusted prepare receipt changed");
    files(this.root, this.path);
    const editable = parseManifest(
      checkedPath(this.root, join(this.path, "candidate.json")),
    );
    if (
      this.manifest.path !== this.path ||
      editable.path !== this.path ||
      canonical(editable.protected) !== canonical(this.manifest.protected) ||
      canonical(editable.sourceHashes) !== canonical(this.manifest.sourceHashes)
    )
      throw new Error(
        "Candidate manifest protected/source inventory does not match trusted receipt",
      );
    const current = protectedInventory(this.root),
      expected = this.manifest.protected;
    const missing = Object.keys(expected).filter(
        (name) => !Object.hasOwn(current, name),
      ),
      added = Object.keys(current).filter(
        (name) => !Object.hasOwn(expected, name),
      );
    if (missing.length || added.length)
      throw new Error(
        "Protected inventory changed; missing=" +
          missing.join(",") +
          "; added=" +
          added.join(","),
      );
    const changed = Object.keys(expected).filter(
      (name) => expected[name] !== current[name],
    );
    if (changed.length)
      throw new Error("Protected file changed: " + changed.join(","));
  }
  changes() {
    return candidateSources.map((file) => ({
      file,
      changed:
        hash(readFileSync(join(this.path, "learner", file))) !==
        this.manifest.sourceHashes[file],
    }));
  }
  environment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // An embedding's Node test context otherwise suppresses this independent test process.
    for (const name of Object.keys(env))
      if (/^CUR_/i.test(name) || /^NODE_TEST_CONTEXT$/i.test(name))
        delete env[name];
    return {
      ...env,
      CUR_MODEL_DIR: join(this.path, "models"),
      CUR_DATA_DIR: join(this.path, "datasets"),
      PYTHONPYCACHEPREFIX: join(this.path, "cache", "python"),
      TORCH_HOME: join(this.path, "cache", "torch"),
      XDG_CACHE_HOME: join(this.path, "cache"),
      TEMP: join(this.path, "tmp"),
      TMP: join(this.path, "tmp"),
    };
  }
  child(command: string, args: string[], timeout = 60000, sourceTests = false) {
    this.verify();
    const cwd = sourceTests ? this.root : this.path;
    const result = spawnSync(command, args, {
      cwd,
      env: this.environment(),
      encoding: "utf8",
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    const report = {
      command,
      args,
      cwd,
      exitCode: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      timeoutMs: timeout,
      protectionError: undefined as string | undefined,
    };
    try {
      this.verify();
    } catch (error) {
      report.protectionError =
        error instanceof Error ? error.message : String(error);
    }
    return report;
  }
}

export type CandidateReport = {
  status: "PASS" | "FAIL";
  protectedFilesUnchanged: boolean;
  activation: string;
  errors: string[];
  [name: string]: unknown;
};

/** The trusted runner writes evidence even when the child fails or changes candidate paths. */
export async function candidateOperation(
  root: string,
  requested: string,
  operation: "check" | "run",
  work: (guard: CandidateGuard, report: CandidateReport) => Promise<void>,
) {
  const trustedRoot = canonicalPath(root),
    report: CandidateReport = {
      status: "FAIL",
      protectedFilesUnchanged: false,
      activation: "not performed; separate independent audit required",
      errors: [],
    };
  let guard: CandidateGuard | undefined;
  try {
    guard = new CandidateGuard(trustedRoot, requested);
    report.changes = guard.changes();
    await work(guard, report);
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (guard)
      try {
        guard.verify();
        report.protectedFilesUnchanged = true;
      } catch (error) {
        report.errors.push(
          error instanceof Error ? error.message : String(error),
        );
      }
  }
  report.status =
    report.errors.length === 0 && report.protectedFilesUnchanged
      ? "PASS"
      : "FAIL";
  const attempts = join(trustedRoot, ".candidates", ".attempts");
  mkdirSync(attempts, { recursive: true });
  checkedPath(trustedRoot, attempts);
  const output = join(attempts, operation + "-" + randomUUID() + ".json");
  writeFileSync(output, JSON.stringify(report, null, 2), { flag: "wx" });
  return { report, output };
}
