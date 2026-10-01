import assert from "node:assert/strict";
import { test } from "node:test";
import { exerciseExampleContracts } from "../evaluation/example-contracts.js";

test("actual generic, Lense, Python Agent-OS and custom examples share runtime authority and real browser effects", async () => {
  const report = await exerciseExampleContracts();
  assert.equal(report.behaviorStatus, "PASS");
  assert.equal(report.checks.length, 7);
  assert.ok(report.checks.every((check: any) => check.status === "PASS"));
  assert.equal(
    report.evidenceLevel,
    "headless browser, authenticated HTTP and injected host RPC",
  );
});
