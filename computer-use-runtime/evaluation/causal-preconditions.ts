import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import * as sourceApi from "../src/index.js";
import type { ControlledPair } from "../src/compiler/preconditions.js";

const compiledLibrary = process.argv.includes("--compiled");
const {
  Store,
  hash,
  canonical,
  BrowserAdapter,
  Runtime,
  seal,
  seedForm,
  PreconditionStudy,
} = (
  compiledLibrary
    ? await import(pathToFileURL(resolve("dist/src/index.js")).href)
    : sourceApi
) as typeof sourceApi;

const namespace = resolve("evidence/completion/causal");
const directory = resolve(
  process.argv[2] || join(namespace, "attempt-" + Date.now()),
);
if (
  !directory.startsWith(namespace + "\\") &&
  !directory.startsWith(namespace + "/")
)
  throw new Error("Use a new evidence/completion/causal attempt directory");
mkdirSync(namespace, { recursive: true });
mkdirSync(directory, { recursive: false });
const protocolBytes = readFileSync(
  "evaluation/causal-preconditions.protocol.json",
);
const protocol = JSON.parse(protocolBytes.toString());
writeFileSync(join(directory, "protocol.json"), protocolBytes, { flag: "wx" });
const protectedBefore = Object.fromEntries(
  protocol.protected.map((path: string) => [path, hash(readFileSync(path))]),
);
function sourceIdentity() {
  const result = spawnSync("python", ["scripts/source-identity.py"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0)
    throw new Error("Source identity failed: " + result.stderr);
  return JSON.parse(result.stdout);
}
const sourceBefore = sourceIdentity();
const store = new Store(join(directory, "store"));
const adapter = await new BrowserAdapter(store, "causal-preconditions").start();
const runtime = new Runtime(store, adapter);
const base = seedForm();
const baseline = seal({
  ...base,
  id: "causal.baseline",
  status: "draft",
  preconditions: [],
  budgets: { steps: 2, retries: 0 },
  provenance: {
    kind: "hand_authored",
    demonstrations: [],
    tests: [],
    uncertain: [],
  },
});
const grant = {
  fixturePath: resolve("fixtures/conditional-form.html"),
  fixtureSha256: hash(readFileSync("fixtures/conditional-form.html")),
  protocolSha256: hash(protocolBytes),
  profileName: protocol.scope,
  fact: "docsOpen" as const,
  baseline,
};
const study = new PreconditionStudy(runtime, adapter, grant);
const report: any = {
  schemaVersion: 1,
  evidenceKind: "actual-runtime-resettable-browser",
  libraryMode: compiledLibrary ? "built-public-export" : "source-public-export",
  protocolSha256: grant.protocolSha256,
  fixtureSha256: grant.fixtureSha256,
  baselineHash: baseline.hash,
  sourceBefore,
  claimLimit: protocol.claimLimit,
  checks: {},
  failures: [],
};
function check(name: string, condition: boolean, evidence: unknown) {
  report.checks[name] = { passed: condition, evidence };
  if (!condition) throw new Error(name);
}
async function pairs(names: string[], phase: "training" | "heldout") {
  const pairs: ControlledPair[] = [];
  for (const name of names) {
    const positive = await study.run(true, name, phase),
      negative = await study.run(false, name, phase);
    pairs.push({ positiveRunId: positive.id, negativeRunId: negative.id });
  }
  return pairs;
}
try {
  const training = await pairs(protocol.trainingNames, "training");
  const { draft, inference } = study.infer(training, "causal.learned-guard");
  writeFileSync(
    join(directory, "draft-before-heldout.json"),
    JSON.stringify({ draft, inference }, null, 2),
    { flag: "wx" },
  );
  check(
    "three_controlled_training_pairs",
    inference.pairs.length >= 3 && new Set(inference.parameterHashes).size >= 3,
    inference,
  );
  check(
    "draft_changes_only_tested_precondition",
    draft.status === "draft" &&
      canonical(draft.machine) === canonical(baseline.machine) &&
      canonical(draft.preconditions) === '["docsOpen"]',
    {
      draftHash: draft.hash,
      baselineHash: baseline.hash,
      preconditions: draft.preconditions,
    },
  );
  let prematureRejected = false;
  try {
    study.publish(draft, [], [], []);
  } catch {
    prematureRejected = true;
  }
  check("publication_rejected_without_heldout_evidence", prematureRejected, {});
  const heldout = await pairs(protocol.heldoutNames, "heldout");
  const positives: string[] = [],
    negativeGuards: string[] = [];
  for (const name of protocol.heldoutNames) {
    const positive = await study.run(true, name, "guard", draft),
      negative = await study.run(false, name, "guard", draft);
    positives.push(positive.id);
    negativeGuards.push(negative.id);
  }
  const published = study.publish(draft, heldout, positives, negativeGuards);
  check(
    "heldout_pairs_and_exact_candidate_publication",
    published.status === "published",
    { heldout, positives, negativeGuards, publishedHash: published.hash },
  );
  check(
    "false_precondition_blocks_every_action",
    negativeGuards.every(
      (id) =>
        !store
          .events(0, id)
          .some((event) =>
            ["requested", "authorized", "dispatched", "acknowledged"].includes(
              event.type,
            ),
          ),
    ),
    negativeGuards.map((id) => ({
      id,
      status: store.run(id).status,
      error: store.run(id).error,
    })),
  );
  const rolled = runtime.registry.rollback(draft.id, draft.hash);
  check(
    "rollback_restores_exact_draft",
    rolled.hash === draft.hash && rolled.status === "draft",
    { restoredHash: rolled.hash },
  );
  const restored = runtime.registry.rollback(draft.id, published.hash);
  check(
    "rollback_can_restore_qualified_publication",
    restored.hash === published.hash,
    { restoredHash: restored.hash },
  );
  report.runs = store.runs();
  report.events = store.events();
  report.trials = store.list("causal-trials");
  report.publication = store.get("causal-publications", published.hash);
} catch (error) {
  report.failures.push(String(error));
  process.exitCode = 1;
} finally {
  await runtime.close();
  report.sourceAfter = sourceIdentity();
  report.protectedAfter = Object.fromEntries(
    protocol.protected.map((path: string) => [path, hash(readFileSync(path))]),
  );
  report.protectedBefore = protectedBefore;
  report.protectedUnchanged =
    canonical(protectedBefore) === canonical(report.protectedAfter);
  report.sourceUnchanged =
    report.sourceBefore.sha256 === report.sourceAfter.sha256;
  report.passed =
    !report.failures.length &&
    report.protectedUnchanged &&
    report.sourceUnchanged &&
    Object.values(report.checks).every((value: any) => value.passed);
  writeFileSync(
    join(directory, "report.json"),
    JSON.stringify(report, null, 2),
    { flag: "wx" },
  );
  store.close();
  console.log(
    JSON.stringify({
      passed: report.passed,
      sourceUnchanged: report.sourceUnchanged,
      checks: Object.keys(report.checks).length,
      failures: report.failures,
      directory,
    }),
  );
}
