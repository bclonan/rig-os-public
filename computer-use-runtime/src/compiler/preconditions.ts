import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserAdapter } from "../adapters/browser.js";
import { Runtime } from "../runtime/index.js";
import { structuredTask } from "./intent.js";
import { ObjectiveVerifier } from "../predicates/index.js";
import { checkSkill, seal } from "../skills/index.js";
import { canonical, hash, type Store } from "../storage/index.js";
import {
  validate,
  type Action,
  type Observation,
  type PredicateEvidence,
  type Receipt,
  type SkillCapsule,
  type TaskContract,
} from "../contracts/index.js";

export interface PreconditionGrant {
  fixturePath: string;
  fixtureSha256: string;
  protocolSha256: string;
  profileName: string;
  fact: "docsOpen";
  baseline: SkillCapsule;
}
export interface ControlledPair {
  positiveRunId: string;
  negativeRunId: string;
}
interface ActiveControl {
  locator: string;
  enabled: boolean;
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
}
interface TrialRecord {
  schemaVersion: 1;
  runId: string;
  phase: "training" | "heldout" | "guard";
  profileHash: string;
  resetId: string;
  condition: boolean;
  controls: ActiveControl[];
  journalHash: string;
  artifact: string;
}
export interface PreconditionInference {
  schemaVersion: 1;
  draftHash: string;
  baselineHash: string;
  profileHash: string;
  fixtureSha256: string;
  protocolSha256: string;
  fact: "docsOpen";
  implementationSha256: string;
  pairs: ControlledPair[];
  parameterHashes: string[];
  evidenceArtifacts: string[];
  scope: string;
  claim: string;
}

const normalizedContract = (task: TaskContract) => {
  const { id: _id, correlationId: _correlationId, ...body } = task;
  return body;
};
const issued = (action: Action) => ({
  operation: action.operation,
  args: action.args,
  scope: action.scope,
});
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Trusted embedder/evaluator only. Generated candidates cannot grant access to
 * another fixture or change the protocol, baseline, condition, or verifier. */
export class PreconditionStudy {
  readonly grant: Readonly<PreconditionGrant>;
  readonly profileHash: string;
  readonly implementationSha256 = hash(readFileSync(new URL(import.meta.url)));
  private readonly store: Store;
  constructor(
    readonly runtime: Runtime,
    readonly adapter: BrowserAdapter,
    grant: PreconditionGrant,
  ) {
    if (
      runtime.adapter !== adapter ||
      adapter.constructor !== BrowserAdapter ||
      runtime.verifier.constructor !== ObjectiveVerifier
    )
      throw new Error(
        "Controlled discovery requires the actual BrowserAdapter and independent ObjectiveVerifier in one Runtime lane",
      );
    if (
      resolve(grant.fixturePath) !==
        resolve("fixtures/conditional-form.html") ||
      grant.fact !== "docsOpen" ||
      !/^[a-f0-9]{64}$/.test(grant.protocolSha256)
    )
      throw new Error("Unsupported controlled fixture profile");
    checkSkill(grant.baseline);
    const steps = grant.baseline.machine.states.flatMap((state) => state.steps);
    if (
      grant.baseline.effects.some((effect) => effect !== "edit") ||
      grant.baseline.preconditions.length ||
      grant.baseline.dependencies.length ||
      grant.baseline.machine.onVerificationError ||
      steps.length !== 2 ||
      canonical(
        steps.map((step) => ({
          operation: step.operation,
          args: step.args,
          scope: step.scope,
        })),
      ) !==
        canonical([
          {
            operation: "fill",
            args: { locator: "name", value: "$name" },
            scope: "edit",
          },
          { operation: "click", args: { locator: "apply" }, scope: "edit" },
        ]) ||
      grant.baseline.machine.states.some(
        (state) =>
          state.transitions?.length ||
          state.onError ||
          state.steps.some((step) => step.guard || step.verify),
      )
    )
      throw new Error(
        "Controlled profile requires an unguarded edit-only fill/click baseline without recovery",
      );
    this.store = runtime.store;
    this.grant = freeze(structuredClone(grant));
    this.profileHash = hash(canonical(this.grant));
    this.checkFixture();
  }
  private checkFixture() {
    if (
      hash(readFileSync(new URL(import.meta.url))) !== this.implementationSha256
    )
      throw new Error(
        "Controlled discovery implementation changed during the study",
      );
    if (hash(readFileSync(this.grant.fixturePath)) !== this.grant.fixtureSha256)
      throw new Error("Trusted controlled fixture source changed");
  }
  async run(
    condition: boolean,
    name: string,
    phase: TrialRecord["phase"],
    skill: SkillCapsule = this.grant.baseline,
  ) {
    this.checkFixture();
    if (
      typeof condition !== "boolean" ||
      typeof name !== "string" ||
      name.length < 1 ||
      name.length > 80
    )
      throw new Error("Controlled condition and literal parameter are invalid");
    checkSkill(skill);
    const baseline = this.grant.baseline;
    if (
      canonical(skill.machine) !== canonical(baseline.machine) ||
      canonical(skill.inputs) !== canonical(baseline.inputs) ||
      canonical(skill.effects) !== canonical(baseline.effects) ||
      skill.preconditions.some((fact) => fact !== this.grant.fact)
    )
      throw new Error(
        "Candidate changed the controlled action sequence or authorization",
      );
    if (
      phase !== "guard" &&
      skill.hash !== baseline.hash &&
      !this.store.get<PreconditionInference>("causal-inferences", skill.hash)
    )
      throw new Error("Candidate lacks controlled inference evidence");
    const task = structuredTask(
      "Publish the authorized display name",
      {
        host: this.adapter.host,
        session: this.adapter.session,
        identity: this.adapter.identity,
      },
      { name },
      skill.id,
    );
    task.budgets = { steps: 2, deadlineMs: 10000 };
    const resetId = randomUUID();
    let controls: ActiveControl[] = [];
    const run = await this.runtime.testCandidate(task, skill, async () => {
      this.checkFixture();
      await this.adapter.page.goto(
        pathToFileURL(resolve(this.grant.fixturePath)).href +
          `?condition=${condition}&reset=${resetId}`,
      );
      controls = await this.adapter.page.evaluate(() =>
        ["name", "apply"].map((locator) => {
          const item = document.querySelector<
            HTMLInputElement | HTMLButtonElement
          >(`[data-control="${locator}"]`)!;
          const rect = item.getBoundingClientRect();
          return {
            locator,
            enabled: !item.disabled,
            visible: rect.width > 0 && rect.height > 0,
            bounds: {
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
            },
          };
        }),
      );
      const observed = await this.runtime.observe(task);
      if (
        observed.facts[this.grant.fact] !== condition ||
        controls.some((control) => !control.enabled || !control.visible)
      )
        throw new Error(
          "Controlled condition or active controls were not independently observed",
        );
      this.store.append(
        task.id,
        "causal_setup",
        {
          profileHash: this.profileHash,
          fixtureSha256: this.grant.fixtureSha256,
          protocolSha256: this.grant.protocolSha256,
          resetId,
          phase,
          condition,
          controls,
          observation: observed,
        },
        task.correlationId,
      );
    });
    this.checkFixture();
    const events = this.store.events(0, run.id);
    const bytes = canonical({ run, events });
    const record: TrialRecord = {
      schemaVersion: 1,
      runId: run.id,
      phase,
      profileHash: this.profileHash,
      resetId,
      condition,
      controls,
      journalHash: hash(bytes),
      artifact: this.store.artifact(bytes),
    };
    this.store.put("causal-trials", run.id, record);
    return run;
  }
  private trial(id: string) {
    this.checkFixture();
    const record = this.store.get<TrialRecord>("causal-trials", id);
    if (
      !record ||
      record.runId !== id ||
      record.profileHash !== this.profileHash ||
      hash(this.store.artifactRead(record.artifact)) !== record.journalHash
    )
      throw new Error("Missing trusted controlled trial provenance");
    const run = this.store.run(id),
      events = this.store.events(0, id);
    if (hash(canonical({ run, events })) !== record.journalHash)
      throw new Error("Controlled run or journal changed after measurement");
    if (
      events.some((event) =>
        [
          "uncertain",
          "rejected",
          "cleanup_failed",
          "recovery",
          "verification_recovery",
        ].includes(event.type),
      ) ||
      run.status === "reconciliation_required"
    )
      throw new Error(
        "Uncertain or interrupted input cannot qualify as a causal negative",
      );
    const setup = events.filter((event) => event.type === "causal_setup");
    if (
      setup.length !== 1 ||
      canonical((setup[0].data as any).controls) !==
        canonical(record.controls) ||
      (setup[0].data as any).resetId !== record.resetId ||
      (setup[0].data as any).observation.facts[this.grant.fact] !==
        record.condition ||
      record.controls.some((control) => !control.enabled || !control.visible)
    )
      throw new Error(
        "Trial condition and active controls lack independent setup evidence",
      );
    const requested = events
      .filter((event) => event.type === "requested")
      .map((event) => validate<Action>("Action", event.data));
    const acknowledged = events
      .filter((event) => event.type === "acknowledged")
      .map((event) => validate<Receipt>("Receipt", event.data));
    if (
      new Set(requested.map((action) => action.id)).size !== requested.length ||
      new Set(acknowledged.map((receipt) => receipt.actionId)).size !==
        acknowledged.length ||
      requested.some(
        (action) =>
          action.runId !== id ||
          !events.some(
            (event) =>
              event.type === "authorized" &&
              (event.data as any).actionId === action.id,
          ) ||
          !events.some(
            (event) =>
              event.type === "dispatched" &&
              (event.data as any).actionId === action.id,
          ),
      ) ||
      requested.length !== acknowledged.length ||
      acknowledged.some(
        (receipt) =>
          receipt.runId !== id ||
          !requested.some((action) => action.id === receipt.actionId) ||
          !["acknowledged", "effect_verified"].includes(receipt.phase),
      )
    )
      throw new Error("Issued actions lack exact bound delivery receipts");
    const experiences = events
      .filter((event) => event.type === "experience")
      .map(
        (event) =>
          event.data as {
            before: Observation;
            after: Observation;
            action: Action;
            receipt: Receipt;
            skillHash: string;
            label: string;
          },
      );
    for (const [index, experience] of experiences.entries()) {
      for (const observation of [experience.before, experience.after]) {
        validate("Observation", observation);
        if (!observation.image)
          throw new Error("Trial requires actual before and after image bytes");
        this.store.artifactRead(observation.image);
      }
      if (
        canonical(experience.action) !== canonical(requested[index]) ||
        canonical(experience.receipt) !== canonical(acknowledged[index]) ||
        experience.skillHash !== run.bindings.skillHash ||
        ["unknown", "failure"].includes(experience.label)
      )
        throw new Error("Trial action effects are unknown or failed");
    }
    return {
      run,
      record,
      events,
      requested,
      experiences,
      setupObservation: (setup[0].data as any).observation as Observation,
    };
  }
  private completion(
    trial: ReturnType<PreconditionStudy["trial"]>,
    condition: boolean,
  ) {
    const verification = trial.events.filter(
      (event) => event.type === "verification",
    );
    if (
      verification.length !== 1 ||
      trial.requested.length !== 2 ||
      trial.experiences.length !== 2 ||
      trial.run.cursor !== 2
    )
      throw new Error(
        "Controlled pair must deliver the complete same action sequence before independent completion measurement",
      );
    const event = verification[0],
      data = event.data as {
        observation: Observation;
        evidence: PredicateEvidence[];
      };
    const observation = validate<Observation>("Observation", data.observation);
    if (
      observation.host !== trial.run.contract.target.host ||
      observation.session !== trial.run.contract.target.session ||
      observation.target !== trial.run.contract.target.identity
    )
      throw new Error(
        "Completion observation does not bind the authorized target",
      );
    const measured = new ObjectiveVerifier().verify(
      trial.run.contract,
      observation,
    );
    if (!observation.image)
      throw new Error("Completion observation requires actual image evidence");
    this.store.artifactRead(observation.image);
    if (
      data.evidence.length !== measured.length ||
      data.evidence.some(
        (evidence, index) =>
          evidence.kind !== "completion" ||
          evidence.detector !== measured[index].detector ||
          evidence.predicate !== measured[index].predicate ||
          evidence.truth !== measured[index].truth ||
          evidence.observationId !== observation.id ||
          evidence.scope !== observation.target ||
          evidence.expiresAt < event.at ||
          evidence.truth === "UNKNOWN",
      ) ||
      measured.some(
        (evidence) => evidence.truth !== (condition ? "TRUE" : "FALSE"),
      )
    )
      throw new Error(
        "Completion evidence is not an independently bound known positive or FALSE negative",
      );
    if (
      condition
        ? trial.run.status !== "succeeded" ||
          !trial.events.some(
            (event) =>
              event.type === "completed" &&
              (event.data as any).status === "succeeded",
          )
        : trial.run.status !== "blocked"
    )
      throw new Error(
        "Trial outcome does not match the independently measured completion",
      );
  }
  private pairs(pairs: ControlledPair[], phase: "training" | "heldout") {
    if (
      pairs.length < 3 ||
      pairs.length > 20 ||
      new Set(pairs.flatMap((pair) => [pair.positiveRunId, pair.negativeRunId]))
        .size !==
        pairs.length * 2
    )
      throw new Error(
        "At least three independent controlled pairs are required",
      );
    const parameterHashes: string[] = [],
      evidenceArtifacts: string[] = [];
    for (const pair of pairs) {
      const positive = this.trial(pair.positiveRunId),
        negative = this.trial(pair.negativeRunId);
      if (
        positive.record.phase !== phase ||
        negative.record.phase !== phase ||
        !positive.record.condition ||
        negative.record.condition ||
        positive.record.resetId === negative.record.resetId ||
        positive.run.bindings.skillHash !== this.grant.baseline.hash ||
        negative.run.bindings.skillHash !== this.grant.baseline.hash ||
        canonical(normalizedContract(positive.run.contract)) !==
          canonical(normalizedContract(negative.run.contract)) ||
        canonical(positive.record.controls) !==
          canonical(negative.record.controls) ||
        canonical(positive.requested.map(issued)) !==
          canonical(negative.requested.map(issued))
      )
        throw new Error(
          "Pair changed the authorized contract, active controls, baseline, or issued action sequence",
        );
      const p = { ...positive.setupObservation.facts },
        n = { ...negative.setupObservation.facts };
      if (p[this.grant.fact] !== true || n[this.grant.fact] !== false)
        throw new Error("Candidate condition must be a measured Boolean fact");
      delete p[this.grant.fact];
      delete n[this.grant.fact];
      if (
        canonical(p) !== canonical(n) ||
        canonical(positive.setupObservation.frame) !==
          canonical(negative.setupObservation.frame)
      )
        throw new Error("Controlled pair changed another observed condition");
      this.completion(positive, true);
      this.completion(negative, false);
      for (let index = 0; index < positive.experiences.length; index++) {
        const beforePositive = { ...positive.experiences[index].before.facts };
        const beforeNegative = { ...negative.experiences[index].before.facts };
        if (
          beforePositive[this.grant.fact] !== true ||
          beforeNegative[this.grant.fact] !== false
        )
          throw new Error(
            "Controlled Boolean condition changed before a delivered action",
          );
        delete beforePositive[this.grant.fact];
        delete beforeNegative[this.grant.fact];
        if (canonical(beforePositive) !== canonical(beforeNegative))
          throw new Error(
            "Controlled pair changed another fact before a delivered action",
          );
      }
      parameterHashes.push(hash(canonical(positive.run.contract.parameters)));
      evidenceArtifacts.push(
        positive.record.artifact,
        negative.record.artifact,
      );
    }
    if (new Set(parameterHashes).size < 3)
      throw new Error(
        "Controlled pairs require at least three varied parameter sets",
      );
    return { parameterHashes, evidenceArtifacts };
  }
  infer(pairs: ControlledPair[], candidateId: string) {
    const measured = this.pairs(pairs, "training");
    if (this.store.get("skills", candidateId))
      throw new Error("Candidate ID already exists");
    const draft = seal({
      ...this.grant.baseline,
      id: candidateId,
      status: "draft",
      description:
        "Controlled Boolean precondition inferred from independently measured positive and negative action trials",
      preconditions: [this.grant.fact],
      provenance: {
        kind: "compiled",
        demonstrations: pairs.flatMap((pair) => [
          pair.positiveRunId,
          pair.negativeRunId,
        ]),
        tests: [],
        uncertain: [],
      },
    });
    const inference: PreconditionInference = {
      schemaVersion: 1,
      draftHash: draft.hash,
      baselineHash: this.grant.baseline.hash,
      profileHash: this.profileHash,
      fixtureSha256: this.grant.fixtureSha256,
      protocolSha256: this.grant.protocolSha256,
      implementationSha256: this.implementationSha256,
      fact: this.grant.fact,
      pairs: structuredClone(pairs),
      ...measured,
      scope: this.grant.profileName,
      claim:
        "The tested Boolean condition predicted completion for the same delivered fill/click sequence in the controlled resettable fixture. Broader causality is untested.",
    };
    this.store.transaction(() => {
      this.runtime.registry.put(draft);
      this.store.put("causal-candidates", draft.id, {
        schemaVersion: 1,
        draftHash: draft.hash,
        profileHash: this.profileHash,
      });
      this.store.put("causal-inferences", draft.hash, inference);
    });
    return { draft, inference };
  }
  publish(
    draft: SkillCapsule,
    heldoutPairs: ControlledPair[],
    positiveIds: string[],
    negativeGuardIds: string[],
  ) {
    const inference = this.store.get<PreconditionInference>(
      "causal-inferences",
      draft.hash,
    );
    if (
      !inference ||
      inference.profileHash !== this.profileHash ||
      draft.status !== "draft" ||
      this.runtime.registry.get(draft.id).hash !== draft.hash
    )
      throw new Error("Publication requires this exact controlled draft");
    this.pairs(inference.pairs, "training");
    const heldout = this.pairs(heldoutPairs, "heldout");
    if (
      heldout.parameterHashes.some((parameter) =>
        inference.parameterHashes.includes(parameter),
      )
    )
      throw new Error("Held-out parameters overlap training");
    if (
      positiveIds.length < 3 ||
      negativeGuardIds.length < 3 ||
      new Set([...positiveIds, ...negativeGuardIds]).size !==
        positiveIds.length + negativeGuardIds.length
    )
      throw new Error(
        "Publication needs three exact candidate positives and three independent no-action guard negatives",
      );
    const candidateParameters = positiveIds.map((id) =>
      hash(canonical(this.store.run(id).contract.parameters)),
    );
    const negativeParameters = negativeGuardIds.map((id) =>
      hash(canonical(this.store.run(id).contract.parameters)),
    );
    if (
      heldout.parameterHashes.some(
        (parameter) =>
          !candidateParameters.includes(parameter) ||
          !negativeParameters.includes(parameter),
      )
    )
      throw new Error(
        "Every held-out parameter needs an exact candidate positive and no-action guard negative",
      );
    for (const id of positiveIds) {
      const trial = this.trial(id);
      if (
        trial.record.phase !== "guard" ||
        !trial.record.condition ||
        trial.run.bindings.skillHash !== draft.hash ||
        !heldout.parameterHashes.includes(
          hash(canonical(trial.run.contract.parameters)),
        )
      )
        throw new Error("Candidate positive is not an unseen exact-draft test");
      this.completion(trial, true);
    }
    for (const id of negativeGuardIds) {
      const trial = this.trial(id);
      const preconditions = trial.events.filter(
        (event) => event.type === "preconditions",
      );
      if (
        trial.record.phase !== "guard" ||
        trial.record.condition ||
        trial.run.bindings.skillHash !== draft.hash ||
        trial.run.status !== "blocked" ||
        !heldout.parameterHashes.includes(
          hash(canonical(trial.run.contract.parameters)),
        ) ||
        trial.requested.length ||
        trial.experiences.length ||
        preconditions.length !== 1 ||
        (preconditions[0].data as any).observation.facts[this.grant.fact] !==
          false ||
        !(preconditions[0].data as any).predicates.includes(this.grant.fact)
      )
        throw new Error(
          "False precondition must be independently observed and stop all actions",
        );
    }
    const allIds = [...inference.pairs, ...heldoutPairs]
      .flatMap((pair) => [pair.positiveRunId, pair.negativeRunId])
      .concat(positiveIds, negativeGuardIds);
    const approval = {
      schemaVersion: 1,
      kind: "controlled-precondition-publication",
      candidateHash: draft.hash,
      baselineHash: this.grant.baseline.hash,
      profileHash: this.profileHash,
      fixtureSha256: this.grant.fixtureSha256,
      protocolSha256: this.grant.protocolSha256,
      implementationSha256: this.implementationSha256,
      inferenceHash: hash(canonical(inference)),
      positiveTests: positiveIds,
      heldoutPairs,
      negativeGuardIds,
      trials: allIds.map((id) => this.trial(id).record),
      evidenceArtifacts: [
        ...inference.evidenceArtifacts,
        ...heldout.evidenceArtifacts,
        ...[...positiveIds, ...negativeGuardIds].map(
          (id) => this.trial(id).record.artifact,
        ),
      ],
    };
    this.store.put("causal-publication-approvals", draft.hash, {
      ...approval,
      artifact: this.store.artifact(canonical(approval)),
    });
    const published = this.runtime.registry.publish(draft.id, positiveIds);
    this.store.put("causal-publications", published.hash, {
      draftHash: draft.hash,
      heldoutPairs,
      positiveIds,
      negativeGuardIds,
      profileHash: this.profileHash,
      scope: inference.scope,
    });
    return published;
  }
}
