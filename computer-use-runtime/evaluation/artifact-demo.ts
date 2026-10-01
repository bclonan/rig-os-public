import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { Store, hash } from "../src/storage/index.js";
import { DesktopRouter } from "../src/adapters/desktop.js";
import { Runtime } from "../src/runtime/index.js";
import { service } from "../src/service/index.js";
import { RuntimeClient } from "../src/sdk/index.js";
import { OllamaProvider } from "../src/providers/index.js";
import type { ArtifactSpec } from "../src/assistant/artifact.js";
import type { ModelProvider } from "../src/contracts/ports.js";

const directory = resolve(
  process.env.CUR_ARTIFACT_EVIDENCE ||
    `evidence/completion/artifacts-${Date.now()}`,
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
const sourceBefore = fingerprint();
const model = process.env.CUR_ARTIFACT_MODEL || "qwen3.5:4b";
const report: any = {
  status: "NOT RUN",
  at: new Date().toISOString(),
  level:
    "actual local model, public research tool, authenticated service and live Vue console",
  model,
  sourceBefore,
  runs: [],
  generations: [],
  checks: [],
  error: undefined,
};
let corrupted = false;
const provider = new OllamaProvider(model);
const instrumented: ModelProvider = {
  capabilities: provider.capabilities,
  async generate(prompt, schema, signal) {
    const started = Date.now();
    const result = await provider.generate(prompt, schema, signal);
    const raw = structuredClone(result);
    let injected = false;
    if (prompt.includes("FAULT_INJECTION_REPAIR") && !corrupted) {
      corrupted = true;
      injected = true;
      const rows = (result as { rows: Record<string, unknown>[] }).rows;
      rows[0].doubled = Number(rows[0].doubled) + 1;
    }
    report.generations.push({
      started,
      durationMs: Date.now() - started,
      promptHash: hash(prompt),
      raw,
      delivered: result,
      injectedFault: injected,
    });
    console.log(
      JSON.stringify({
        generation: report.generations.length,
        durationMs: Date.now() - started,
        injectedFault: injected,
      }),
    );
    return result;
  },
};
const store = new Store(mkdtempSync(join(tmpdir(), "cur-artifact-live-")));
const router = new DesktopRouter(store, () => instrumented);
const runtime = new Runtime(store, router);
const app = await service(runtime);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(String(error)));
let client: RuntimeClient;
async function collect(id: string, name: string) {
  const until = Date.now() + 300000;
  let run: any;
  do {
    run = await client.status(id);
    if (!["running", "queued"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < until);
  const detail = await client.request("/api/artifact-tasks/" + id);
  report.runs.push({ name, ...detail, events: store.events(0, id) });
  console.log(
    JSON.stringify({ case: name, status: run.status, error: run.error }),
  );
  assert.equal(run.status, "succeeded", run.error || name + " did not succeed");
  assert.equal(detail.state.verification.valid, true);
  const output = await client.artifactOutput(id);
  assert.equal(hash(output.content), detail.state.outputHash);
  writeFileSync(
    join(
      directory,
      name + (detail.spec.kind === "csv_transform" ? ".csv" : ".json"),
    ),
    output.content,
  );
  return detail;
}
async function submit(
  name: string,
  goal: string,
  spec: ArtifactSpec,
  input?: string,
) {
  const run = await client.request("/api/artifact-tasks", "POST", {
    goal,
    model,
    spec,
    ...(input === undefined ? {} : { input }),
  });
  return collect(run.id, name);
}
try {
  await router.start();
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  client = new RuntimeClient(url, store.token());
  report.providerDiscovery = await OllamaProvider.discover();
  assert.ok(
    report.providerDiscovery.models.some((m: any) => m.name === model),
    "Selected installed local model is required",
  );
  const jsonSpec: ArtifactSpec = {
    schemaVersion: 1,
    kind: "json_projection",
    source: { operation: "workspace_read", location: "source.json" },
    outputPath: "output.json",
    columns: [
      { name: "label", source: "name", transform: "uppercase" },
      { name: "doubled", source: "quantity", transform: "number", multiply: 2 },
    ],
    filter: { field: "quantity", operator: "gte", value: 3 },
    sortBy: "label",
  };
  const repair = await submit(
    "local-repair",
    "FAULT_INJECTION_REPAIR. Project uppercase labels and doubled quantities, include quantities at least 3 and sort labels.",
    jsonSpec,
    '[{"name":"Cedar","quantity":7},{"name":"Ash","quantity":2},{"name":"Birch","quantity":4}]',
  );
  assert.equal(repair.attempts[0].verification.valid, false);
  assert.equal(repair.attempts.at(-1).verification.valid, true);
  assert.ok(report.generations.some((g: any) => g.injectedFault));
  report.checks.push(
    "Injected post-generation numeric error caused a failed independent check followed by a real local-model repair under the unchanged source and spec",
  );
  await submit(
    "csv-transform",
    "Uppercase item names and calculate total as three times price.",
    {
      schemaVersion: 1,
      kind: "csv_transform",
      source: { operation: "workspace_read", location: "source.csv" },
      outputPath: "output.csv",
      columns: [
        { name: "item", source: "name", transform: "uppercase" },
        { name: "total", source: "price", transform: "number", multiply: 3 },
      ],
    },
    'name,price\n"cedar, red",4\nash,2\n',
  );
  await submit(
    "public-research",
    "Read the repository branch list and create sorted JSON rows of branch and commit identifiers.",
    {
      schemaVersion: 1,
      kind: "json_projection",
      source: {
        operation: "research_read",
        location:
          "https://api.github.com/repos/openai/openai-agents-python/branches",
      },
      outputPath: "branches.json",
      columns: [
        { name: "branch", source: "name" },
        { name: "commit", source: "commit.sha" },
      ],
      sortBy: "branch",
    },
  );
  await page.goto(url);
  await page
    .getByLabel("Local service token", { exact: true })
    .fill(store.token());
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Artifacts", exact: true }).click();
  await page
    .getByRole("heading", { name: "Construct a verified artifact" })
    .waitFor();
  await page.getByLabel("Local model", { exact: true }).selectOption(model);
  await page
    .getByLabel("Request", { exact: true })
    .fill("Create uppercase labels and doubled quantities through the console");
  await page
    .getByLabel("Source JSON or CSV")
    .fill('[{"name":"Alder","quantity":3}]');
  await page
    .getByLabel("Output columns and calculations")
    .fill(
      '[{"name":"label","source":"name","transform":"uppercase"},{"name":"doubled","source":"quantity","transform":"number","multiply":2}]',
    );
  const previous = new Set(store.runs().map((r) => r.id));
  await page
    .getByRole("button", { name: "Construct and verify", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.body.textContent?.includes("queued") ||
      document.body.textContent?.includes("running") ||
      document.body.textContent?.includes("succeeded"),
  );
  let uiRun = store.runs().find((run) => !previous.has(run.id));
  for (let attempt = 0; !uiRun && attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 100));
    uiRun = store.runs().find((run) => !previous.has(run.id));
  }
  assert.ok(uiRun, "Console submitted the task");
  await collect(uiRun.id, "console-output");
  await page
    .getByRole("button", { name: "Preview verified output", exact: true })
    .click({ timeout: 15000 });
  await page
    .getByText('[{"label":"ALDER","doubled":6}]', { exact: true })
    .waitFor();
  await page.screenshot({
    path: join(directory, "console.png"),
    fullPage: true,
  });
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download verified output", exact: true })
    .click();
  const download = await downloadEvent;
  await download.saveAs(join(directory, "console-downloaded.json"));
  assert.equal(errors.length, 0, errors.join("\n"));
  report.checks.push(
    "Live console submits, polls, previews and downloads independently verified actual local-model output without a page error",
  );
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  report.store = store.root;
  report.pageErrors = errors;
  await browser.close();
  await app.close();
  report.sourceAfter = fingerprint();
  report.sourceStable =
    report.sourceBefore.sha256 === report.sourceAfter.sha256;
  if (!report.sourceStable) {
    report.status = "FAIL";
    report.error = (report.error || "") + "; Source changed during evaluation";
    process.exitCode = 1;
  }
  writeFileSync(
    join(directory, "results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      status: report.status,
      error: report.error,
      evidence: directory,
    }),
  );
}
