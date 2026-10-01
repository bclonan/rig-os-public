import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Store, hash } from "../src/storage/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { seal, seedForm } from "../src/skills/index.js";
import {
  PreconditionStudy,
  type ControlledPair,
} from "../src/compiler/preconditions.js";

async function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-preconditions-")));
  const adapter = await new BrowserAdapter(store, "precondition-test").start();
  const runtime = new Runtime(store, adapter);
  const baseline = seal({
    ...seedForm(),
    id: "conditional.baseline",
    status: "draft",
    preconditions: [],
    budgets: { steps: 2, retries: 0 },
  });
  const grant = {
    fixturePath: resolve("fixtures/conditional-form.html"),
    fixtureSha256: hash(readFileSync("fixtures/conditional-form.html")),
    protocolSha256: hash(
      readFileSync("evaluation/causal-preconditions.protocol.json"),
    ),
    profileName: "Controlled fixture test only",
    fact: "docsOpen" as const,
    baseline,
  };
  return {
    store,
    adapter,
    runtime,
    baseline,
    study: new PreconditionStudy(runtime, adapter, grant),
    grant,
  };
}
test("measured positive/FALSE pairs infer a draft, heldout guard gates publication, and rollback restores bytes", async () => {
  const { store, runtime, study, baseline } = await setup();
  try {
    const training: ControlledPair[] = [],
      heldout: ControlledPair[] = [];
    for (const name of ["Cedar 11", "Maple 29", "Hazel 37"]) {
      const positive = await study.run(true, name, "training"),
        negative = await study.run(false, name, "training");
      assert.equal(positive.status, "succeeded");
      assert.equal(negative.status, "blocked");
      assert.equal(
        store
          .events(0, negative.id)
          .filter((event) => event.type === "acknowledged").length,
        2,
      );
      training.push({ positiveRunId: positive.id, negativeRunId: negative.id });
    }
    assert.throws(
      () => study.infer(training.slice(0, 2), "too-few"),
      /three independent/,
    );
    assert.throws(
      () => study.infer([training[0], training[0], training[0]], "repeated"),
      /independent/,
    );
    const { draft, inference } = study.infer(training, "conditional.learned");
    assert.deepEqual(draft.preconditions, ["docsOpen"]);
    assert.deepEqual(draft.machine, baseline.machine);
    assert.equal(draft.status, "draft");
    assert.equal(inference.evidenceArtifacts.length, 6);
    assert.throws(() => study.publish(draft, [], [], []), /three independent/);
    assert.throws(
      () => study.grant.baseline.preconditions.push("ready"),
      TypeError,
    );
    const candidatePositives: string[] = [],
      guardNegatives: string[] = [];
    for (const name of ["Sequoia 9831", "Juniper 829", "Spruce 413"]) {
      const positive = await study.run(true, name, "heldout"),
        negative = await study.run(false, name, "heldout");
      heldout.push({ positiveRunId: positive.id, negativeRunId: negative.id });
      candidatePositives.push((await study.run(true, name, "guard", draft)).id);
      const guard = await study.run(false, name, "guard", draft);
      guardNegatives.push(guard.id);
      assert.equal(guard.status, "blocked");
      assert.match(guard.error!, /precondition docsOpen/);
      assert.equal(
        store.events(0, guard.id).filter((event) => event.type === "requested")
          .length,
        0,
      );
    }
    assert.throws(
      () => study.publish(draft, heldout, candidatePositives, []),
      /guard negatives/,
    );
    assert.throws(
      () => runtime.registry.publish(draft.id, candidatePositives),
      /exact inference and approval/,
    );
    store.db
      .prepare("DELETE FROM kv WHERE namespace=? AND key=?")
      .run("causal-inferences", draft.hash);
    assert.throws(
      () => runtime.registry.publish(draft.id, candidatePositives),
      /exact inference and approval/,
    );
    store.put("causal-inferences", draft.hash, inference);
    const published = study.publish(
      draft,
      heldout,
      candidatePositives,
      guardNegatives,
    );
    assert.equal(published.status, "published");
    assert.equal(
      runtime.registry.rollback(draft.id, draft.hash).hash,
      draft.hash,
    );
    assert.equal(
      runtime.registry.rollback(draft.id, published.hash).hash,
      published.hash,
    );
    runtime.registry.rollback(draft.id, draft.hash);
    const approval = store.get<any>(
      "causal-publication-approvals",
      draft.hash,
    )!;
    store.put("causal-publication-approvals", draft.hash, {
      ...approval,
      fixtureSha256: "0".repeat(64),
    });
    assert.throws(
      () => runtime.registry.publish(draft.id, candidatePositives),
      /approval bytes or frozen profile changed/,
    );
    store.put("causal-publication-approvals", draft.hash, approval);
    store.db
      .prepare("DELETE FROM kv WHERE namespace=? AND key=?")
      .run("causal-publication-approvals", draft.hash);
    assert.throws(
      () => runtime.registry.publish(draft.id, candidatePositives),
      /exact inference and approval/,
    );
    store.put("causal-publication-approvals", draft.hash, approval);
    store.append(
      guardNegatives[0],
      "candidate_self_attestation",
      { unchanged: true },
      "tamper",
    );
    assert.throws(
      () => runtime.registry.publish(draft.id, candidatePositives),
      /trial journal changed/,
    );
    store.append(
      training[0].negativeRunId,
      "candidate_self_attestation",
      { success: true },
      "tamper",
    );
    assert.throws(() => study.infer(training, "tampered"), /journal changed/);
  } finally {
    await runtime.close();
    store.close();
  }
});
test("uncertain delivered-negative trial and unsupported verifier grant cannot become causal evidence", async () => {
  const { store, adapter, runtime, study, grant } = await setup();
  try {
    const pairs: ControlledPair[] = [];
    for (const name of ["Normal Pine 7", "Normal Elm 13", "Fault Ash 19"]) {
      const positive = await study.run(true, name, "training");
      const execute = adapter.execute.bind(adapter);
      if (name.startsWith("Fault"))
        adapter.execute = async (action, signal) => {
          const receipt = await execute(action, signal);
          if (action.operation === "click")
            throw new Error("Injected lost reply after real fixture click");
          return receipt;
        };
      const negative = await study.run(false, name, "training");
      adapter.execute = execute;
      pairs.push({ positiveRunId: positive.id, negativeRunId: negative.id });
      if (name.startsWith("Fault"))
        assert.equal(negative.status, "reconciliation_required");
    }
    assert.throws(() => study.infer(pairs, "uncertain-rejected"), /Uncertain/);
    assert.throws(
      () =>
        new PreconditionStudy(runtime, adapter, {
          ...grant,
          fixtureSha256: "0".repeat(64),
        }),
      /source changed/,
    );
    assert.throws(
      () =>
        new PreconditionStudy(
          new Runtime(store, adapter, { verify: () => [] }),
          adapter,
          grant,
        ),
      /independent ObjectiveVerifier/,
    );
    const changed = seal({
      ...grant.baseline,
      machine: {
        ...grant.baseline.machine,
        initial: "bad",
        states: [
          {
            id: "bad",
            monitor: [],
            steps: [
              {
                id: "bad",
                operation: "click",
                args: { locator: "apply" },
                scope: "edit",
              },
            ],
          },
        ],
      },
    });
    await assert.rejects(
      () => study.run(true, "Candidate mutation", "heldout", changed),
      /changed the controlled action/,
    );
  } finally {
    await runtime.close();
    store.close();
  }
});
