import { readFileSync, writeFileSync } from "node:fs";
import { Controller } from "../src/learner/index.js";
import assert from "node:assert/strict";
const manifest = JSON.parse(
  readFileSync("models/recorded-candidate/recorded-manifest.json", "utf8"),
);
const reports = JSON.parse(
  readFileSync("models/recorded-candidate/training.json", "utf8"),
);
const outcomes = [];
for (const row of manifest.rows) {
  if (row.corrections.length) assert.equal(row.teacher_choice, -100);
  assert.equal(row.policyUsesPostActionData, false);
}
assert.equal(manifest.counts.positive, 4);
assert.equal(manifest.counts.failureOrUnknown, 8);
for (const seed of [17, 41, 73]) {
  const controller = await Controller.load(
    `models/recorded-candidate/${seed}/trained.onnx`,
  );
  const row = manifest.rows.find((r: any) => r.teacher_choice >= 0);
  const prediction = await controller.rank(
    { features: [53 / 255, 168 / 255, 102 / 255] } as any,
    row.candidates.map((descriptor: number[]) => ({ descriptor })),
    new Float32Array(row.history.flat()),
  );
  await controller.close();
  assert.ok(prediction.scores.every(Number.isFinite));
  assert.equal(reports.find((r: any) => r.seed === seed).recordedRows, 12);
  outcomes.push({ seed, prediction });
}
const result = {
  status: "PASS",
  evidenceLevel:
    "actual recorded fixture screenshots, controlled correction injection, CPU candidate updates and Node ONNX inference",
  counts: manifest.counts,
  training: reports,
  outcomes,
  promotion: "not performed",
  learningBenefit: "not evaluated; does not replace sealed audit",
};
writeFileSync(
  "evidence/recorded-learning.json",
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    status: result.status,
    counts: result.counts,
    seeds: outcomes.map((o) => o.seed),
  }),
);
