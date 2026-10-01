import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator } from "playwright";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { service } from "../src/service/index.js";
import { Store } from "../src/storage/index.js";

// Browser/API contract fixtures only. No CLI invocation, model generation or OS input.
const store = new Store(mkdtempSync(join(tmpdir(), "cur-provider-console-")));
const adapter = await new BrowserAdapter(store).start();
const runtime = new Runtime(store, adapter);
const app = await service(runtime);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const report: {
  status: string;
  level: string;
  checks: string[];
  pageErrors: string[];
  reason?: string;
} = {
  status: "NOT RUN",
  level:
    "Real Vue, Chromium, authenticated Fastify and disposable SQLite. Explicit provider/window/POST fixtures exercise chooser behavior. No model, CLI, remote request or native input qualification.",
  checks: [],
  pageErrors: [],
};
page.on("pageerror", (error) => report.pageErrors.push(String(error)));
const requests: { path: string; body: Record<string, any> }[] = [];
const choices = [
  ...["local-a", "local-b", "local-c", "local-d", "local-e"].map((model) => ({
    provider: "ollama",
    model,
    name: model,
    available: true,
    local: true,
    modalities: model === "local-b" ? ["text"] : ["text", "image"],
  })),
  {
    provider: "codex-cli",
    model: "default",
    name: "default",
    available: true,
    local: false,
    modalities: ["text", "image"],
  },
  {
    provider: "claude-cli",
    model: "default",
    name: "default",
    available: false,
    local: false,
    reason: "CLI fixture is unavailable",
    modalities: ["text"],
  },
];
const fulfill = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
async function clear(picker: Locator) {
  const checked = picker.locator('input[name$="-providers"]:checked');
  while (await checked.count()) await checked.first().uncheck();
}
async function choose(picker: Locator, name: string) {
  await picker.getByRole("checkbox", { name, exact: true }).check();
}
async function plan() {
  await page
    .getByRole("button", { name: "Plan desktop task", exact: true })
    .click();
}
try {
  await page.route("**/api/capabilities", async (route) => {
    const result = await route.fetch();
    const data = await result.json();
    await route.fulfill(
      fulfill({
        ...data,
        providers: {
          available: true,
          models: choices
            .filter((item) => item.provider === "ollama")
            .map((item) => ({ name: item.model })),
          choices,
        },
      }),
    );
  });
  await page.route("**/api/desktop/windows", (route) =>
    route.fulfill(
      fulfill({
        available: true,
        windows: [
          {
            handle: 123,
            pid: 456,
            title: "Owned Paint fixture",
            executable: "fixture/mspaint.exe",
          },
        ],
        apps: [],
        system: { name: "Fixture OS" },
      }),
    ),
  );
  for (const path of [
    "/api/desktop/tasks",
    "/api/artifact-tasks",
    "/api/drawing-plans",
  ])
    await page.route("**" + path, async (route) => {
      const request = route.request();
      if (request.method() !== "POST") return route.continue();
      requests.push({ path, body: request.postDataJSON() });
      await route.fulfill(
        path === "/api/drawing-plans"
          ? fulfill({
              id: "fixture-preview",
              task: { goal: "Draw a circle" },
              segmentCount: 8,
              providerResults: {
                members: [
                  { provider: "ollama", model: "local-a", status: "valid" },
                  {
                    provider: "codex-cli",
                    model: "default",
                    status: "failed",
                    reason: "Synthetic provider unavailable",
                  },
                ],
                selectedMember: 0,
                selectionMethod: "first-valid",
              },
            })
          : fulfill(
              {
                error:
                  "Synthetic provider unavailable. Choose another model and retry.",
              },
              400,
            ),
      );
    });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  await page.goto(url);
  await page
    .getByLabel("Local service token", { exact: true })
    .fill(store.token());
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page
    .getByRole("heading", { name: "New desktop task", exact: true })
    .waitFor();
  const picker = page.locator("#desktop-model");
  await page
    .getByLabel("What should the assistant do?")
    .fill("Read the current app controls");
  await plan();
  await page
    .getByRole("alert")
    .filter({ hasText: "Synthetic provider unavailable" })
    .waitFor();
  assert.deepEqual(requests.at(-1)?.body.providers, [
    { provider: "ollama", model: "local-a" },
  ]);
  assert.equal(requests.at(-1)?.body.strategy, "fallback");
  assert.equal(requests.at(-1)?.body.allowRemote, false);
  assert.equal(requests.at(-1)?.body.model, "local-a");
  report.checks.push(
    "Default local model and fallback payload; recoverable provider failure",
  );

  await clear(picker);
  const beforeEmpty = requests.length;
  await plan();
  await picker
    .getByRole("alert")
    .filter({ hasText: "Choose at least one model" })
    .waitFor();
  assert.equal(requests.length, beforeEmpty);
  assert.equal(
    await picker.evaluate((element) => element === document.activeElement),
    true,
  );
  report.checks.push(
    "Empty selection blocks POST and focuses the chooser error",
  );

  for (const model of ["local-a", "local-b", "local-c", "local-d"])
    await choose(picker, "Ollama " + model);
  assert.equal(
    await picker
      .getByRole("checkbox", { name: "Ollama local-e", exact: true })
      .isDisabled(),
    true,
  );
  await clear(picker);
  await choose(picker, "Codex CLI default");
  const consent = picker.locator("#desktop-remote-consent");
  const beforeConsent = requests.length;
  await plan();
  assert.equal(requests.length, beforeConsent);
  assert.equal(
    await consent.evaluate(
      (element: HTMLInputElement) => element.validity.valueMissing,
    ),
    true,
  );
  await consent.check();
  await picker.getByLabel("Parallel evaluation", { exact: true }).check();
  await plan();
  assert.deepEqual(requests.at(-1)?.body.providers, [
    { provider: "codex-cli", model: "default" },
  ]);
  assert.equal(requests.at(-1)?.body.strategy, "ensemble");
  assert.equal(requests.at(-1)?.body.allowRemote, true);
  await choose(picker, "Ollama local-a");
  assert.equal(await consent.isChecked(), false);
  await consent.check();
  await page
    .getByLabel("Send screenshots to the selected providers", { exact: true })
    .check();
  assert.equal(await consent.isChecked(), false);
  report.checks.push(
    "Four-model limit, CLI-only payload, parallel strategy, explicit consent and consent reset after selection or screenshot changes",
  );

  await clear(picker);
  await choose(picker, "Ollama local-b");
  const beforeVision = requests.length;
  await plan();
  await picker
    .getByRole("alert")
    .filter({ hasText: "Screenshots are unsupported" })
    .waitFor();
  assert.equal(requests.length, beforeVision);
  await page
    .getByLabel("Send screenshots to the selected providers", { exact: true })
    .uncheck();
  await plan();
  assert.equal(requests.length, beforeVision + 1);
  report.checks.push(
    "Known text-only model rejects screenshots; turning screenshots off recovers",
  );

  await clear(picker);
  await picker
    .getByText("Add a custom model or CLI model", { exact: true })
    .click();
  await picker.getByRole("button", { name: "Add model", exact: true }).click();
  await picker
    .getByRole("alert")
    .filter({ hasText: "Enter a model name" })
    .waitFor();
  await picker
    .getByLabel("Model name", { exact: true })
    .fill("custom-installed:latest");
  await picker.getByRole("button", { name: "Add model", exact: true }).click();
  await plan();
  assert.equal(
    requests.at(-1)?.body.providers[0].model,
    "custom-installed:latest",
  );
  report.checks.push("Custom local model name and invalid-input recovery");

  await clear(picker);
  await choose(picker, "Ollama local-a");
  await page
    .getByLabel("What should the assistant do?")
    .fill("Draw a circle in Paint");
  const beforeDrawing = requests.length;
  await plan();
  await page
    .getByRole("heading", { name: "Review the drawing program", exact: true })
    .waitFor();
  await page.waitForResponse(
    (response) => response.url().endsWith("/api/capabilities"),
    { timeout: 10000 },
  );
  assert.equal(
    await page
      .getByRole("heading", { name: "Review the drawing program", exact: true })
      .isVisible(),
    true,
  );
  assert.equal(requests.length, beforeDrawing + 1);
  assert.equal(requests.at(-1)?.path, "/api/drawing-plans");
  assert.equal(requests.at(-1)?.body.handle, 123);
  await page
    .getByText("Drawing proposal sources and failures", { exact: true })
    .click();
  await page
    .getByRole("listitem")
    .filter({ hasText: "Synthetic provider unavailable" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Approve drawing program", exact: true })
      .isVisible(),
    true,
  );
  assert.equal(store.runs().length, 0);
  report.checks.push(
    "Primary drawing submission opens a reviewed bounded preview; per-source failure stays visible; no execution without approval",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  const local = picker.getByRole("checkbox", {
    name: "Ollama local-a",
    exact: true,
  });
  await local.focus();
  await page.keyboard.press("Space");
  assert.equal(await local.isChecked(), false);
  const target = await picker.locator("label").first().boundingBox();
  assert.ok(target && target.height >= 48);
  report.checks.push(
    "390px layout, 48px checkbox targets and keyboard Space selection",
  );

  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Artifacts", exact: true })
    .click();
  const artifact = page.locator("#artifact-model");
  await artifact.waitFor();
  await clear(artifact);
  await choose(artifact, "Codex CLI default");
  await artifact.locator("#artifact-remote-consent").check();
  await artifact.getByLabel("Parallel evaluation", { exact: true }).check();
  await page
    .getByRole("button", { name: "Construct and verify", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Synthetic provider unavailable" })
    .waitFor();
  assert.equal(requests.at(-1)?.path, "/api/artifact-tasks");
  assert.deepEqual(requests.at(-1)?.body.providers, [
    { provider: "codex-cli", model: "default" },
  ]);
  assert.equal(requests.at(-1)?.body.allowRemote, true);
  assert.equal(requests.at(-1)?.body.strategy, "ensemble");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  await page.screenshot({
    path: join(tmpdir(), "cur-provider-console-mobile.png"),
    fullPage: true,
  });
  report.checks.push(
    "Artifact workspace uses the same chooser, remote consent and multi-provider payload on mobile",
  );
  assert.deepEqual(report.pageErrors, []);
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.reason = String(error);
  process.exitCode = 1;
} finally {
  writeFileSync(
    process.env.CUR_PROVIDER_CONSOLE_REPORT ||
      join(tmpdir(), "cur-provider-console-report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  await browser.close();
  await app.close();
  console.log(JSON.stringify(report));
}
