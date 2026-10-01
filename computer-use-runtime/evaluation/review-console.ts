import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { AdaptiveSelector } from "../src/learner/selector.js";
import { seedForm } from "../src/skills/index.js";
import { service } from "../src/service/index.js";
import { seal } from "../src/skills/index.js";

const store = new Store(mkdtempSync(join(tmpdir(), "cur-review-console-")));
const adapter = await new BrowserAdapter(store).start();
const selector = new AdaptiveSelector(store);
const runtime = new Runtime(
  store,
  adapter,
  undefined,
  undefined,
  selector.select.bind(selector),
);
runtime.registry.put(seedForm());
const app = await service(runtime);
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1050 },
  acceptDownloads: true,
});
const errors: string[] = [];
const screenshotRoot = process.env.CUR_REVIEW_SCREENSHOT_DIR || "evidence";
mkdirSync(screenshotRoot, { recursive: true });
page.on("pageerror", (e) => errors.push(String(e)));
const report: any = {
  status: "NOT RUN",
  at: new Date().toISOString(),
  level:
    "real Vue console, Fastify, SQLite, Chromium fixture and ONNX; no native desktop or model text generation",
  checks: [],
};
async function until(
  predicate: () => boolean,
  message: string,
  timeout = 15000,
) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await delay(50);
  }
}
async function nav(name: string) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name, exact: true })
    .click();
}
try {
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  await page.goto(url + "/#runs");
  await page
    .getByLabel("Local service token", { exact: true })
    .fill("incorrect");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Local token required" })
    .waitFor();
  await page
    .getByLabel("Local service token", { exact: true })
    .fill(store.token());
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page
    .getByRole("heading", { name: "Browser fixture task", exact: true })
    .waitFor();
  report.checks.push(
    "incorrect-token error and successful retry; Runs deep link",
  );
  await page.getByRole("button", { name: "Take over", exact: true }).click();
  await assert.rejects(
    () => adapter.acquire("review-revoked"),
    /takeover|human/i,
  );
  await page
    .getByRole("button", { name: "Return control", exact: true })
    .click();
  assert.ok(await adapter.acquire("review-returned"));
  await adapter.release("review-returned");
  report.checks.push(
    "Take over revokes the lease; Return control restores acquisition",
  );
  await page.getByLabel("Display name", { exact: true }).fill("");
  await page.getByRole("button", { name: "Run task", exact: true }).click();
  assert.equal(store.runs().length, 0);
  assert.equal(
    await page
      .getByLabel("Display name", { exact: true })
      .evaluate((el: HTMLInputElement) => el.validity.valueMissing),
    true,
  );
  report.checks.push("native required-field validation sends no task");
  for (const name of ["Review Aspen", "Review Birch", "Review Cedar"]) {
    await nav("Runs");
    await page.getByLabel("Display name", { exact: true }).fill(name);
    const count = store.runs().length;
    await page.getByRole("button", { name: "Run task", exact: true }).click();
    await until(
      () =>
        store.runs().length === count + 1 &&
        store.runs().at(-1)?.status === "succeeded",
      "Fixture execution failed",
    );
    await page
      .locator("button.run small")
      .filter({ hasText: "succeeded" })
      .first()
      .waitFor();
    await page.getByRole("button", { name: "Record run", exact: true }).click();
    await until(
      () => store.list("demonstrations").length === count + 1,
      "Recording not persisted",
    );
    await page
      .getByRole("heading", { name: "Owned controller", exact: true })
      .waitFor();
  }
  report.checks.push(
    "three visible task submissions, independent completion, recordings and cross-view persistence",
  );
  await nav("Skills");
  for (const box of await page.getByRole("checkbox").all()) await box.check();
  await page
    .getByRole("button", {
      name: "Compile recorded demonstrations",
      exact: true,
    })
    .click();
  await until(
    () => runtime.registry.list().some((s) => s.id === "form.compiled"),
    "Compilation missing",
  );
  const candidate = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "form.compiled" }) });
  await candidate.locator("summary").click();
  await candidate
    .getByRole("button", {
      name: "Test candidate and publish if it passes",
      exact: true,
    })
    .click();
  await until(
    () => runtime.registry.get("form.compiled").status === "published",
    "Candidate publication failed",
  );
  assert.equal(
    runtime.registry.get("form.compiled").provenance.tests.length,
    3,
  );
  // A published version changes the details key. Reopen its new component.
  await candidate.locator("summary").click();
  const downloadEvent = page.waitForEvent("download");
  await candidate
    .getByRole("button", { name: "Export capsule", exact: true })
    .click();
  const download = await downloadEvent;
  const path = await download.path();
  assert.equal(
    JSON.parse(readFileSync(path!, "utf8")).hash,
    runtime.registry.get("form.compiled").hash,
  );
  report.checks.push(
    "selected recording compilation; real variation tests; evidence-gated publication; downloaded capsule hash",
  );
  const published = runtime.registry.get("form.compiled");
  runtime.registry.put(
    seal({
      ...published,
      version: "1.0.1",
      description: "A separately versioned candidate",
      status: "draft",
    }),
  );
  const rolledBack = await app.inject({
    method: "POST",
    url: "/api/skills/form.compiled/rollback",
    headers: {
      host: "127.0.0.1",
      authorization: "Bearer " + store.token(),
      "idempotency-key": "review-skill-rollback",
      "x-correlation-id": "review",
    },
    payload: { hash: published.hash },
  });
  assert.equal(rolledBack.statusCode, 200, rolledBack.body);
  assert.equal(runtime.registry.get("form.compiled").hash, published.hash);
  report.checks.push("skill rollback API restores the exact published version");
  await nav("Learning");
  await page
    .getByRole("button", { name: "Activate audited model", exact: true })
    .first()
    .click();
  await until(
    () => store.get("model", "active") === "owned-17",
    "Model activation missing",
  );
  await page.getByText(/Active model: owned-17/).waitFor();
  await page
    .getByRole("button", { name: "Roll back model", exact: true })
    .click();
  await until(
    () => store.get("model", "active") === "fixed",
    "Model rollback missing",
  );
  await page.getByText(/Active model: fixed/).waitFor();
  await page
    .getByRole("button", { name: "Verify frozen audit", exact: true })
    .click();
  await until(
    () =>
      store
        .list<any>("jobs")
        .some((j) => j.type === "verify-audit" && j.status === "finished"),
    "Audit verification failed",
  );
  report.checks.push(
    "audited model activation, rollback reflected in UI and read-only frozen audit verification",
  );
  await page
    .getByRole("button", { name: "Mark first step incorrect", exact: true })
    .click();
  await until(
    () => store.list<any>("demonstrations").some((d) => !d.verified),
    "Correction not persisted",
  );
  await page.locator("pre").filter({ hasText: '"label": "failure"' }).waitFor();
  await nav("Skills");
  assert.equal(
    await page.locator('input[type="checkbox"]:disabled').count(),
    1,
  );
  report.checks.push(
    "negative correction updates the recording and removes it from compilation selection",
  );
  if (process.env.CUR_REVIEW_TRAINING === "1") {
    await nav("Learning");
    for (const [name, type] of [
      ["Train three seeds", "train"],
      ["Train from recorded experience", "train-recordings"],
    ]) {
      await page.getByRole("button", { name, exact: true }).click();
      await until(
        () => store.list<any>("jobs").some((j) => j.type === type),
        "Training job not persisted",
      );
      await until(
        () =>
          store
            .list<any>("jobs")
            .some((j) => j.type === type && j.status !== "running"),
        "Training deadline",
        240000,
      );
      const job = store.list<any>("jobs").find((j) => j.type === type);
      assert.equal(job.status, "finished", job.output);
      report.checks.push(
        name + " completed real CPU training through the console",
      );
      console.log(JSON.stringify({ training: type, status: job.status }));
      if (type === "train-recordings") {
        const reports = JSON.parse(
          readFileSync(
            join(store.root, "jobs", job.id, "models", "training.json"),
            "utf8",
          ),
        );
        assert.ok(
          reports.every(
            (r: any) => r.recordedRows > 0 && r.onnxMaxError < 0.0001,
          ),
        );
        report.training = reports.map((r: any) => ({
          seed: r.seed,
          recordedRows: r.recordedRows,
          onnxMaxError: r.onnxMaxError,
          trainingSeconds: r.trainingSeconds,
        }));
      }
    }
  }

  await nav("Evaluation");
  await page.getByRole("button", { name: "Load results", exact: true }).click();
  await page.locator("pre").filter({ hasText: '"learningBenefit"' }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page
    .getByRole("heading", { name: "Frozen audit results", exact: true })
    .waitFor();
  report.checks.push(
    "evaluation load and refresh restore the selected workspace",
  );
  await nav("Runs");
  await page.locator("button.run").last().click();
  await page.locator("summary").filter({ hasText: "completed" }).waitFor();
  const observation = page
    .locator("details")
    .filter({
      has: page.getByRole("button", {
        name: "Replay observation",
        exact: true,
        includeHidden: true,
      }),
    })
    .first();
  await observation.locator("summary").click();
  await observation
    .getByRole("button", { name: "Replay observation", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Recorded observation", exact: true })
    .waitFor();
  await page.waitForFunction(() =>
    [...document.images].some((image) => image.naturalWidth > 0),
  );
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page
    .getByRole("heading", { name: "Live fixture", exact: true })
    .waitFor();
  report.checks.push(
    "historical image replay and live refresh load decoded images and update labels",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Resume", exact: true })
      .isDisabled(),
    true,
  );
  await page.screenshot({
    path: join(screenshotRoot, "review-console.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  await page.screenshot({
    path: join(screenshotRoot, "review-console-mobile.png"),
    fullPage: true,
  });
  report.checks.push(
    "historical run evidence, terminal-state controls and 390px layout",
  );
  assert.deepEqual(errors, []);
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.reason = String(error);
  process.exitCode = 1;
  await page
    .screenshot({
      path: join(screenshotRoot, "review-console-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
} finally {
  report.pageErrors = errors;
  report.runs = store
    .runs()
    .map((r) => ({ id: r.id, status: r.status, skill: r.skill }));
  writeFileSync(
    process.env.CUR_REVIEW_REPORT || "evidence/review-console.json",
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  await selector.close();
  await app.close();
  console.log(JSON.stringify(report));
}
