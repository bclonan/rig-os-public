import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { NativeClient } from "../src/adapters/native.js";
import { DesktopRouter } from "../src/adapters/desktop.js";
import { launchDesktopApp } from "../src/adapters/desktop-apps.js";
import { LocalVisionAssessor } from "../src/providers/vision.js";
import { Runtime } from "../src/runtime/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { service } from "../src/service/index.js";
import { hash, Store } from "../src/storage/index.js";

const directory = resolve(
  "evidence/completion/native-drawing",
  Date.now() + "-" + randomUUID(),
);
mkdirSync(directory, { recursive: true });
const fingerprint = () =>
  JSON.parse(
    execFileSync(
      process.env.CUR_PYTHON || "python",
      ["scripts/source-identity.py"],
      { encoding: "utf8" },
    ),
  );
const report: any = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  status: "FAIL",
  goal: "Draw a recognizable dog in this new Paint document. Do not save, upload or import an image.",
  generatingModel: process.env.CUR_DRAWING_MODEL || "qwen3.6:latest",
  assessorModel: process.env.CUR_DRAWING_ASSESSOR || "qwen3.5:4b",
  evidenceLevel:
    "live Vue console, actual generated geometric plan, native Paint drags and independent canvas-only semantic assessment",
  semanticCompletion: false,
  objectivelyVerifiedSubject: false,
  directory,
};
report.sourceBefore = fingerprint();
let probe: NativeClient | undefined;
let runtime: Runtime | undefined;
let app: Awaited<ReturnType<typeof service>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  assert.equal(
    process.platform,
    "win32",
    "Requires an interactive Windows Paint environment",
  );
  const tags = (await (
    await fetch("http://127.0.0.1:11434/api/tags")
  ).json()) as any;
  report.providerIdentities = tags.models.filter((entry: any) =>
    [report.generatingModel, report.assessorModel].includes(entry.name),
  );
  assert.equal(
    report.providerIdentities.length,
    2,
    "Both exact local model identities must be installed",
  );
  probe = new NativeClient();
  const existing = new Set(
    (await probe.call("windows")).map((entry: any) => entry.handle),
  );
  await launchDesktopApp("paint");
  let window: any;
  for (let attempt = 0; attempt < 50 && !window; attempt++) {
    await delay(200);
    window = (await probe.call("windows")).find(
      (entry: any) =>
        !existing.has(entry.handle) && entry.title === "Untitled - Paint",
    );
  }
  assert.ok(
    window,
    "A new disposable Paint document must exist before any input",
  );
  report.window = window;
  await probe.close();
  probe = undefined;
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-native-drawing-")));
  report.store = store.root;
  const router = new DesktopRouter(store);
  await router.start();
  runtime = new Runtime(store, router);
  app = await service(runtime);
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url);
  await page
    .getByLabel("Local service token", { exact: true })
    .fill(store.token());
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByLabel("One window", { exact: true }).check();
  await page
    .getByLabel("Open app", { exact: true })
    .selectOption(String(window.handle));
  await page.getByLabel("What should the assistant do?").fill(report.goal);
  const modelPicker = page.locator("#desktop-model");
  async function selectModel(model: string) {
    const checked = modelPicker.locator(
      'input[name="desktop-providers"]:checked',
    );
    while (await checked.count()) await checked.first().uncheck();
    await modelPicker
      .getByRole("checkbox", { name: "Ollama " + model, exact: true })
      .check();
  }
  await selectModel(report.generatingModel);
  const planResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/drawing-plans") &&
      response.request().method() === "POST",
    { timeout: 180000 },
  );
  await page
    .getByRole("button", { name: "Plan a bounded Paint drawing", exact: true })
    .click();
  const plannedResponse = await planResponse;
  const plan = await plannedResponse.json();
  assert.ok(plannedResponse.ok(), JSON.stringify(plan));
  report.plan = plan;
  writeFileSync(join(directory, "plan.json"), JSON.stringify(plan, null, 2));
  writeFileSync(
    join(directory, "blank-canvas.png"),
    store.artifactRead(String(plan.initialObservation.facts.canvasImage)),
  );
  await page
    .getByRole("heading", { name: "Review the drawing program" })
    .waitFor();
  await page.screenshot({
    path: join(directory, "approval.png"),
    fullPage: true,
  });
  const executionResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/drawing-plans/${plan.id}/execute`),
  );
  await page
    .getByRole("button", { name: "Approve drawing program", exact: true })
    .click();
  assert.ok((await executionResponse).ok());
  await runtime.execute(plan.id);
  report.run = store.run(plan.id);
  report.events = store.events(0, plan.id);
  writeFileSync(
    join(directory, "execution.json"),
    JSON.stringify({ plan, run: report.run, events: report.events }, null, 2),
  );
  assert.equal(report.run.status, "needs_review", report.run.error);
  const delivered = report.events.filter(
    (entry: any) => entry.type === "acknowledged",
  );
  const requested = report.events.filter(
    (entry: any) => entry.type === "requested",
  );
  assert.ok(plan.segmentCount > 0 && plan.segmentCount <= 120);
  assert.equal(plan.setupActions.length, 2);
  assert.equal(delivered.length, plan.segmentCount + plan.setupActions.length);
  const rejected = report.events.filter(
    (entry: any) => entry.type === "rejected",
  );
  assert.ok(rejected.length <= plan.skill.budgets.retries);
  assert.equal(
    requested.length,
    plan.segmentCount + plan.setupActions.length + rejected.length,
  );
  assert.equal(
    new Set(requested.map((entry: any) => entry.data.id)).size,
    requested.length,
  );
  for (const entry of requested) {
    const receipts = [...delivered, ...rejected].filter(
      (receipt: any) => receipt.data.actionId === entry.data.id,
    );
    assert.equal(
      receipts.length,
      1,
      "Each request must have exactly one bound outcome",
    );
    assert.equal(receipts[0].data.runId, plan.id);
    assert.ok(["acknowledged", "rejected"].includes(receipts[0].data.phase));
    if (receipts[0].data.phase === "rejected")
      assert.equal(receipts[0].data.dispatched, false);
  }
  assert.equal(
    report.events.filter((entry: any) => entry.type === "uncertain").length,
    0,
  );
  assert.ok(
    requested.every(
      (entry: any) =>
        ["click", "drag"].includes(entry.data.operation) &&
        entry.data.scope === "edit",
    ),
  );
  const acknowledgedIds = new Set(
    delivered.map((entry: any) => entry.data.actionId),
  );
  const deliveredRequests = requested.filter((entry: any) =>
    acknowledgedIds.has(entry.data.id),
  );
  assert.equal(
    deliveredRequests.filter((entry: any) => entry.data.operation === "click")
      .length,
    2,
  );
  assert.equal(
    deliveredRequests.filter((entry: any) => entry.data.operation === "drag")
      .length,
    plan.segmentCount,
  );
  const after = await runtime.configureEnvironment(async () => {
    await router.prepare(plan.task);
    return runtime!.observe(plan.task);
  });
  report.observation = after;
  writeFileSync(join(directory, "after.png"), store.artifactRead(after.image!));
  const bytes = store.artifactRead(String(after.facts.canvasImage));
  writeFileSync(join(directory, "canvas.png"), bytes);
  report.canvasHash = hash(bytes);
  await selectModel(report.assessorModel);
  await page
    .getByLabel("Subject to check on the canvas", { exact: true })
    .fill("dog");
  const assessmentResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/desktop/tasks/${plan.id}/assess`),
    { timeout: 180000 },
  );
  await page
    .getByRole("button", {
      name: "Assess canvas with selected vision providers",
      exact: true,
    })
    .click();
  const assessedResponse = await assessmentResponse;
  report.assessment = await assessedResponse.json();
  assert.ok(assessedResponse.ok(), JSON.stringify(report.assessment));
  assert.equal(report.assessment.inputHash, report.canvasHash);
  assert.equal(
    store.run(plan.id).status,
    "needs_review",
    "Model assessment must not change task completion",
  );
  const repeatResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/desktop/tasks/${plan.id}/assess`),
    { timeout: 180000 },
  );
  await page
    .getByRole("button", {
      name: "Assess canvas with selected vision providers",
      exact: true,
    })
    .click();
  const repeated = await repeatResponse;
  report.repeatedAssessment = await repeated.json();
  assert.ok(repeated.ok(), JSON.stringify(report.repeatedAssessment));
  assert.equal(report.repeatedAssessment.inputHash, report.canvasHash);
  assert.equal(
    report.repeatedAssessment.providerCalls,
    0,
    "Unchanged scoped pixels and model identity should reuse the assessment",
  );
  assert.equal(report.repeatedAssessment.cacheHit, true);
  assert.notEqual(
    report.repeatedAssessment.observationId,
    report.assessment.observationId,
  );
  report.controls = [];
  const assessor = new LocalVisionAssessor(report.assessorModel);
  const cases = JSON.parse(
    readFileSync("evidence/semantic/cases.json", "utf8"),
  );
  for (const entry of cases.filter(
    (candidate: any) => candidate.expectedRecognizable === false,
  )) {
    const assessment = await assessor.assess("dog", readFileSync(entry.image));
    report.controls.push({
      ...entry,
      imageHash: hash(readFileSync(entry.image)),
      ...assessment,
      passed: assessment.assessment.recognizable === false,
    });
    writeFileSync(
      join(directory, "results.json"),
      JSON.stringify(report, null, 2),
    );
  }
  // Keep the actual dog in its original window and bind a different new blank
  // document. The production adapter must exclude that outside-window subject.
  const outsideWindows = new Set(
    (await router.native!.client.call("windows")).map(
      (entry: any) => entry.handle,
    ),
  );
  await launchDesktopApp("paint");
  let blankWindow: any;
  for (let attempt = 0; attempt < 50 && !blankWindow; attempt++) {
    await delay(200);
    blankWindow = (await router.native!.client.call("windows")).find(
      (entry: any) =>
        !outsideWindows.has(entry.handle) && entry.title === "Untitled - Paint",
    );
  }
  assert.ok(
    blankWindow,
    "The actual outside-target negative needs a separate blank document",
  );
  const blankTask = structuredTask(
    "Inspect this new blank canvas only",
    {
      host: router.native!.host,
      session: router.native!.session,
      identity: String(blankWindow.handle),
    },
    {
      windowPid: blankWindow.pid,
      desktopScope: "window",
      plannerModel: report.assessorModel,
    },
    "desktop.assistant",
  );
  const blankObservation = await runtime.configureEnvironment(async () => {
    await router.prepare(blankTask);
    await router.focus();
    await delay(200);
    return runtime!.observe(blankTask);
  });
  assert.ok(typeof blankObservation.facts.canvasImage === "string");
  const blankBytes = store.artifactRead(
    String(blankObservation.facts.canvasImage),
  );
  writeFileSync(
    join(directory, "actual-outside-target-canvas.png"),
    blankBytes,
  );
  const outsideAssessment = await assessor.assess("dog", blankBytes);
  report.actualOutsideTarget = {
    positiveWindow: report.window,
    positiveCanvasHash: report.canvasHash,
    negativeWindow: blankWindow,
    observation: blankObservation,
    imageHash: hash(blankBytes),
    ...outsideAssessment,
  };
  assert.equal(
    outsideAssessment.assessment.recognizable,
    false,
    "A dog in another window cannot qualify this target canvas",
  );
  report.semanticCompletion =
    report.assessment.assessment.recognizable === true;
  await page.screenshot({
    path: join(directory, "assessment.png"),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.equal(
    report.semanticCompletion,
    true,
    "Independent assessor did not recognize the requested dog",
  );
  assert.ok(
    report.controls.length === 6 &&
      report.controls.every((entry: any) => entry.passed),
    "All prescribed controlled negatives must be rejected",
  );
  report.status = "PASS";
  report.limits = [
    "The generator cannot read examiner outputs before drawing.",
    "Semantic recognition is independent model assessment with six controlled negatives; it is not objective dog ground truth or broad vision calibration.",
    "No document save, overwrite, upload or image import occurs.",
    "All drawing and assessment controls ran through the actual Vue console and authenticated API.",
  ];
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await app?.close();
  if (!app) await runtime?.close();
  await probe?.close();
  const tags = (await (
    await fetch("http://127.0.0.1:11434/api/tags")
  ).json()) as any;
  report.providerIdentitiesAfter = tags.models.filter((entry: any) =>
    [report.generatingModel, report.assessorModel].includes(entry.name),
  );
  report.modelIdentityStable =
    JSON.stringify(report.providerIdentities) ===
    JSON.stringify(report.providerIdentitiesAfter);
  report.sourceAfter = fingerprint();
  report.sourceStable =
    report.sourceBefore.sha256 === report.sourceAfter.sha256;
  if (!report.sourceStable || !report.modelIdentityStable) {
    report.status = "FAIL";
    report.sourceFailure =
      "Source or exact model identities changed during this development attempt";
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  writeFileSync(
    join(directory, "results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      directory,
      status: report.status,
      sourceStable: report.sourceStable,
      error: report.error,
      semanticCompletion: report.semanticCompletion,
      assessment: report.assessment,
      controls: report.controls?.map((entry: any) => ({
        id: entry.id,
        passed: entry.passed,
      })),
    }),
  );
}
