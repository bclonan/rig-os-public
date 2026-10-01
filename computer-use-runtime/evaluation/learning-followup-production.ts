import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store, canonical, hash } from "../src/storage/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { seedForm } from "../src/skills/index.js";
import { ModelRegistry } from "../src/learner/index.js";
import { AdaptiveSelector, repairSkills } from "../src/learner/selector.js";
import { trainingPython } from "../src/learner/python.js";

const directory = resolve(
  process.argv[2] || "evidence/learning-followup-v4/browser",
);
if (!existsSync(join(directory, "audit-sealed.json")))
  throw new Error(
    "Run the frozen final audit before deployed qualification checks",
  );
if (existsSync(join(directory, "production-results.json")))
  throw new Error("Deployed qualification checks already recorded");
const identity = () => {
  const result = spawnSync(trainingPython(), ["scripts/source-identity.py"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("Deployed source identity failed");
  return JSON.parse(result.stdout);
};
const sourceBefore = identity(),
  store = new Store(join(directory, "production-store")),
  adapter = await new BrowserAdapter(store, "deployed-full-heads").start(),
  selector = new AdaptiveSelector(store, adapter.capabilities),
  runtime = new Runtime(
    store,
    adapter,
    undefined,
    undefined,
    selector.select.bind(selector),
  );
const models = new ModelRegistry(store),
  reportPath = join(directory, "production-results.json");
try {
  runtime.registry.put(seedForm());
  for (const skill of repairSkills()) runtime.registry.put(skill);
  const qualified = models.importFollowupAudit(directory);
  const candidate = models.register(
    "qualified-visual-17",
    join(directory, "models", "17", "trained.onnx"),
    17,
  );
  models.activate(candidate.id);
  if (qualified.contextVersion !== 4 || !qualified.visualStateQualified)
    throw new Error("Deployed visual qualification missing");
  const requester = "deployed-private-" + randomUUID();
  const contract = (method: string, name: string) => {
    const value = structuredTask(
      JSON.parse(readFileSync(join(directory, "..", "protocol.json"), "utf8"))
        .goals.final[0][0],
      {
        host: adapter.host,
        session: adapter.session,
        identity: adapter.identity,
      },
      { name },
      method,
    );
    value.requester = requester;
    return value;
  };
  await adapter.reset("both", "shift");
  const prefix = contract("repair.dismiss", "prefix");
  prefix.expected = { dialog: false };
  runtime.submit(prefix, prefix.id);
  await runtime.execute(prefix.id);
  if (store.run(prefix.id).status !== "succeeded")
    throw new Error("Earlier actual repair failed");
  const name = "Deployed unseen " + randomUUID(),
    task = contract("auto", name);
  runtime.submit(task, task.id);
  await runtime.execute(task.id);
  const actual = await adapter.page.locator("#result").textContent();
  const predictionEvent = store
    .events(0, task.id)
    .find((event) => event.type === "controller_prediction");
  const prediction = predictionEvent?.data as
    Record<string, unknown> | undefined;
  const expectedHistory = store
    .events(0, prefix.id)
    .filter((event) => event.type === "experience")
    .map((event) => (event.data as { action: { id: string } }).action.id);
  const deliveredHistory = prediction?.historyActionIds;
  const selectionPass =
    store.run(task.id).status === "succeeded" &&
    actual === name &&
    prediction?.contextVersion === 4 &&
    prediction.masksAppliedBeforeRanking === true &&
    prediction.candidateDescriptorVersion === 2 &&
    (prediction.advice as Record<string, unknown> | undefined)
      ?.forecastAvailable === true &&
    Array.isArray(deliveredHistory) &&
    expectedHistory.some((id) => deliveredHistory.includes(id));
  const incomplete = contract("auto", "");
  incomplete.parameters = {};
  incomplete.unresolved = ["The required display name is missing"];
  runtime.submit(incomplete, incomplete.id);
  const before = await runtime.observe(incomplete),
    eventsBefore = store.events(0, incomplete.id);
  const assessment = await selector.assess(
    store.run(incomplete.id).contract,
    before,
  );
  const advisoryPass =
    assessment.available &&
    assessment.contextVersion === 4 &&
    assessment.advice.clarificationRecommended &&
    assessment.forecast.available === false &&
    store.run(incomplete.id).status === "awaiting_input" &&
    canonical(eventsBefore) === canonical(store.events(0, incomplete.id));
  const rollback = models.rollback();
  const pinnedModelPreserved =
    rollback.active === "fixed" &&
    store.run(incomplete.id).model === candidate.id;
  const sourceAfter = identity();
  const sourceStable = canonical(sourceBefore) === canonical(sourceAfter);
  const passed =
    selectionPass && advisoryPass && pinnedModelPreserved && sourceStable;
  const report = {
    schemaVersion: 1,
    status: passed ? "PASS" : "FAIL",
    candidateSha256: candidate.hash,
    finalAuditSha256: hash(readFileSync(join(directory, "audit-sealed.json"))),
    sourceBefore,
    sourceAfter,
    sourceStable,
    selectionPass,
    advisoryPass,
    pinnedModelPreserved,
    rollback,
    independentPublicResult: actual,
    requestedName: name,
    prediction,
    assessment,
    runs: [prefix.id, task.id, incomplete.id],
    evidenceLevel:
      "Actual production AdaptiveSelector, Runtime, ModelRegistry and browser adapter in isolated store",
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(
    JSON.stringify({
      status: report.status,
      selectionPass,
      advisoryPass,
      pinnedModelPreserved,
      path: reportPath,
    }),
  );
  if (!passed) process.exitCode = 1;
} finally {
  await runtime.close();
  await selector.close();
}
