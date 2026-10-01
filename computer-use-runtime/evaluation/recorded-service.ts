import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { RuntimeClient } from "../src/sdk/index.js";
import { serviceConfig, readServiceToken } from "../src/service/lifecycle.js";
import { join } from "node:path";

const config = serviceConfig();
const client = new RuntimeClient(config.url, readServiceToken(config));
const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const sealed = [
  "evidence/audit-sealed.json",
  "evidence/results.json",
  "evidence/episodes.jsonl",
  "models/17/trained.onnx",
  "models/41/trained.onnx",
  "models/73/trained.onnx",
];
const before = sealed.map(hash);
const initialModels = await client.request("/api/models");
const result: any = {
  status: "NOT RUN",
  level:
    "public HTTP service with recorded fixture images and real CPU training",
};
try {
  const bundle = await client.request("/api/datasets/export");
  assert.ok(bundle.demonstrations.length > 0);
  const key = "recorded-training-" + Date.now();
  const job = await client.request(
    "/api/jobs",
    "POST",
    { type: "train-recordings" },
    key,
  );
  const duplicate = await client.request(
    "/api/jobs",
    "POST",
    { type: "train-recordings" },
    key,
  );
  assert.equal(duplicate.id, job.id);
  assert.match(job.id, /^[a-f0-9-]{36}$/);
  const deadline = Date.now() + 180_000;
  let completed: any;
  while (Date.now() < deadline) {
    completed = (await client.request("/api/jobs")).find(
      (entry: any) => entry.id === job.id,
    );
    if (completed && completed.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.equal(completed?.status, "finished", completed?.output);
  const directory = join(config.root, "jobs", job.id, "models");
  const training = JSON.parse(
    readFileSync(`${directory}/training.json`, "utf8"),
  );
  const manifest = JSON.parse(
    readFileSync(`${directory}/recorded-manifest.json`, "utf8"),
  );
  assert.equal(training.length, 3);
  assert.ok(training.every((report: any) => report.recordedRows > 0));
  assert.deepEqual(sealed.map(hash), before);
  assert.deepEqual(await client.request("/api/models"), initialModels);
  Object.assign(result, {
    status: "PASS",
    jobId: job.id,
    demonstrations: bundle.demonstrations.length,
    counts: manifest.counts,
    seeds: training.map((report: any) => report.seed),
    training,
    auditPreserved: true,
    activeModelUnchanged: true,
    promotion: "not performed",
    learningBenefit: "not evaluated",
  });
} catch (error) {
  Object.assign(result, { status: "FAIL", reason: String(error) });
  process.exitCode = 1;
} finally {
  writeFileSync(
    "evidence/recorded-service.json",
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      status: result.status,
      reason: result.reason,
      counts: result.counts,
      seeds: result.seeds,
    }),
  );
}
