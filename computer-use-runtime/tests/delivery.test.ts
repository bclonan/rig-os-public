import { test } from "node:test";
import assert from "node:assert/strict";
import type { Action, Observation } from "../src/contracts/index.js";
import {
  classifyDelivery,
  UncertainDeliveryError,
} from "../src/contracts/delivery.js";
import { fact } from "../src/predicates/index.js";
import { assessEffectEvidence } from "../src/runtime/effect-evidence.js";

const action = { id: "action-one", runId: "run-one" } as Action;
const receipt = {
  schemaVersion: 1,
  actionId: action.id,
  runId: action.runId,
  at: 1,
  backend: "safe-classifier-test",
  phase: "rejected",
  dispatched: false,
  detail: "No input in this test",
  timings: {},
};

test("nonfinite in-process receipt times cannot establish delivery or non-delivery", () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    for (const phase of ["rejected", "acknowledged", "effect_verified"]) {
      const base = { ...receipt, phase, dispatched: phase !== "rejected" };
      assert.throws(
        () => classifyDelivery(action, { ...base, at: value }),
        UncertainDeliveryError,
      );
      assert.throws(
        () => classifyDelivery(action, { ...base, timings: { input: value } }),
        UncertainDeliveryError,
      );
    }
  }
});

test("finite exact receipts retain rejected false and legacy ACK compatibility", () => {
  assert.equal(classifyDelivery(action, receipt).kind, "not_dispatched");
  for (const phase of ["acknowledged", "effect_verified"]) {
    const { dispatched: _dispatched, ...legacy } = receipt;
    assert.equal(
      classifyDelivery(action, { ...legacy, phase }).kind,
      "acknowledged",
    );
    assert.equal(
      classifyDelivery(action, { ...receipt, phase, dispatched: true }).kind,
      "acknowledged",
    );
  }
});

test("FALSE effects require current scope, observation and expiry for recovery", () => {
  const observation: Observation = {
    schemaVersion: 1,
    id: "before-one",
    host: "test-host",
    session: "test-session",
    target: "owned-fixture",
    at: 100,
    revision: "one",
    frame: { x: 0, y: 0, width: 100, height: 100, scale: 1 },
    focused: true,
    facts: { result: false },
    features: [],
    backend: "safe-classifier-test",
  };
  const evidence = fact(observation, "result");
  assert.equal(
    assessEffectEvidence([evidence], observation, 2100).knownFailure,
    true,
  );
  for (const item of [
    { ...evidence, expiresAt: 2099 },
    { ...evidence, expiresAt: NaN },
    { ...evidence, scope: "another-fixture" },
    { ...evidence, observationId: "before-two" },
  ]) {
    const assessment = assessEffectEvidence([item], observation, 2100);
    assert.equal(assessment.knownFailure, false);
    assert.equal(assessment.unresolved, true);
    assert.equal(assessment.verified, false);
  }
  const staleMonitor = { ...fact(observation, "monitor"), expiresAt: 2099 };
  assert.equal(
    assessEffectEvidence([evidence, staleMonitor], observation, 2100)
      .knownFailure,
    false,
  );
});
