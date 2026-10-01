import { validate, type SkillCapsule } from "../contracts/index.js";
import { readFileSync } from "node:fs";
import { canonical, hash } from "../util/canonical.js";
import type { ExperienceStore, SkillRepository } from "../contracts/ports.js";
import {
  checkImportedSkillPublication,
  commitSkillMigration,
  exportSkillBundle,
  importLegacySkill,
  importSkillBundle,
} from "./bundle.js";
export function seal(skill: SkillCapsule): SkillCapsule {
  return { ...skill, hash: hash(canonical({ ...skill, hash: "" })) };
}
const operations = new Set([
  "fill",
  "click",
  "invoke",
  "select",
  "key",
  "scroll",
  "drag",
  "hold",
  "wait",
  "observe",
  "subskill",
  "focus",
  "type",
  "research_read",
  "workspace_read",
  "workspace_write",
  "construct_artifact",
  "repair_artifact",
]);
export function checkSkill(value: unknown): SkillCapsule {
  const skill = validate<SkillCapsule>("SkillCapsule", value);
  if (skill.id === "." || skill.id === "..")
    throw new Error("Skill ID cannot be a URL dot segment");
  if (seal(skill).hash !== skill.hash) throw new Error("Skill hash mismatch");
  const states = new Set(skill.machine.states.map((s) => s.id));
  if (!states.has(skill.machine.initial))
    throw new Error("Missing initial state");
  if (
    skill.machine.onVerificationError &&
    !states.has(skill.machine.onVerificationError)
  )
    throw new Error("Missing verification recovery target");
  if (states.size !== skill.machine.states.length)
    throw new Error("Duplicate state ID");
  if (
    skill.descriptor.length !== 8 ||
    skill.descriptor.some((x) => !Number.isFinite(x))
  )
    throw new Error("Descriptor must contain eight finite values");
  for (const s of skill.machine.states) {
    if (s.next && !states.has(s.next)) throw new Error("Missing state target");
    if (s.onError && !states.has(s.onError))
      throw new Error("Missing recovery target");
    for (const transition of s.transitions || [])
      if (!states.has(transition.target))
        throw new Error("Missing transition target");
    if (new Set(s.steps.map((step) => step.id)).size !== s.steps.length)
      throw new Error("Duplicate step ID");
    for (const step of s.steps) {
      if (!operations.has(step.operation))
        throw new Error("Unregistered operation");
      if (!skill.effects.includes(step.scope))
        throw new Error("Undeclared effect");
      if (step.waitFor && step.operation !== "wait")
        throw new Error("waitFor requires a wait operation");
      if ((step.operation === "subskill") !== Boolean(step.subskill))
        throw new Error("Subskill operation requires an explicit dependency");
    }
  }
  return skill;
}
export class Registry implements SkillRepository {
  constructor(private store: ExperienceStore) {}
  get(id: string): SkillCapsule {
    const s = this.store.get<SkillCapsule>("skills", id);
    if (!s) throw new Error(`Missing skill ${id}`);
    return checkSkill(s);
  }
  list() {
    return this.store.list<SkillCapsule>("skills");
  }
  version(hashId: string): SkillCapsule {
    const skill = this.store.get<SkillCapsule>("skill-versions", hashId);
    if (!skill || skill.hash !== hashId)
      throw new Error("Pinned skill version is unavailable");
    return checkSkill(skill);
  }
  put(skill: SkillCapsule) {
    checkSkill(skill);
    for (const d of skill.dependencies) this.get(d);
    this.store.put("skill-versions", skill.hash, skill);
    this.store.put("skills", skill.id, skill);
  }
  import(value: unknown) {
    return importLegacySkill(this.store, this, value);
  }
  importBundle(source: Buffer) {
    return importSkillBundle(this.store, this, source);
  }
  migrate(source: Buffer) {
    return commitSkillMigration(this.store, source, { from: 1, to: 2 }, this);
  }
  exportBundle(id: string) {
    return exportSkillBundle(id, this);
  }
  publish(id: string, tests: string[]) {
    const s = this.get(id);
    this.checkControlledPublication(s, tests);
    checkImportedSkillPublication(this.store, this, s, tests);
    if (
      s.dependencies.some(
        (dependency) =>
          !["seed", "published"].includes(this.get(dependency).status),
      )
    )
      throw new Error(
        "Publication requires independently published dependencies",
      );
    if (new Set(tests).size < 3 || s.provenance.uncertain.length)
      throw new Error(
        "Publication needs regression evidence and resolved uncertainty",
      );
    for (const id of tests) {
      const run = this.store.run(id);
      if (
        run.status !== "succeeded" ||
        run.skill !== s.id ||
        run.bindings.skillHash !== s.hash
      )
        throw new Error(
          "Publication evidence must reference successful tests of these exact skill bytes",
        );
      if (
        !this.store
          .events(0, id)
          .some(
            (event) =>
              event.type === "completed" &&
              (event.data as any).status === "succeeded",
          )
      )
        throw new Error(
          "Publication evidence is missing its completion journal",
        );
    }
    const published = seal({
      ...s,
      status: "published",
      provenance: { ...s.provenance, tests },
    });
    this.put(published);
    return published;
  }
  private checkControlledPublication(skill: SkillCapsule, tests: string[]) {
    const marker = this.store.get<any>("causal-candidates", skill.id);
    const inference = this.store.get<any>("causal-inferences", skill.hash);
    if (!marker && !inference) return;
    const approval = this.store.get<any>(
      "causal-publication-approvals",
      skill.hash,
    );
    if (!inference || !approval || (marker && marker.draftHash !== skill.hash))
      throw new Error(
        "Controlled precondition publication requires its exact inference and approval",
      );
    const { artifact, ...body } = approval;
    const sourceHash = hash(
      readFileSync(
        new URL(
          "../compiler/preconditions" +
            (import.meta.url.endsWith(".ts") ? ".ts" : ".js"),
          import.meta.url,
        ),
      ),
    );
    const fixtureHash = hash(readFileSync("fixtures/conditional-form.html"));
    const protocolHash = hash(
      readFileSync("evaluation/causal-preconditions.protocol.json"),
    );
    if (
      approval.schemaVersion !== 1 ||
      approval.kind !== "controlled-precondition-publication" ||
      approval.candidateHash !== skill.hash ||
      inference.draftHash !== skill.hash ||
      approval.inferenceHash !== hash(canonical(inference)) ||
      approval.baselineHash !== inference.baselineHash ||
      approval.profileHash !== inference.profileHash ||
      approval.fixtureSha256 !== fixtureHash ||
      inference.fixtureSha256 !== fixtureHash ||
      approval.protocolSha256 !== protocolHash ||
      inference.protocolSha256 !== protocolHash ||
      approval.implementationSha256 !== sourceHash ||
      inference.implementationSha256 !== sourceHash ||
      artifact !== hash(canonical(body)) ||
      hash(this.store.artifactRead(artifact)) !== artifact ||
      this.store.artifactRead(artifact).toString() !== canonical(body) ||
      !Array.isArray(approval.positiveTests) ||
      canonical([...approval.positiveTests].sort()) !==
        canonical([...tests].sort()) ||
      !Array.isArray(approval.negativeGuardIds) ||
      approval.negativeGuardIds.length < 3 ||
      !Array.isArray(approval.heldoutPairs) ||
      approval.heldoutPairs.length < 3 ||
      !Array.isArray(approval.trials)
    )
      throw new Error(
        "Controlled publication approval bytes or frozen profile changed",
      );
    const records = new Map<string, any>();
    for (const trial of approval.trials) {
      if (
        records.has(trial.runId) ||
        trial.schemaVersion !== 1 ||
        trial.profileHash !== approval.profileHash ||
        trial.artifact !== trial.journalHash ||
        hash(this.store.artifactRead(trial.artifact)) !== trial.journalHash
      )
        throw new Error("Controlled publication trial artifact changed");
      const run = this.store.run(trial.runId),
        events = this.store.events(0, trial.runId);
      if (
        hash(canonical({ run, events })) !== trial.journalHash ||
        events.some((event) =>
          ["uncertain", "cleanup_failed", "reconciliation_required"].includes(
            event.type,
          ),
        ) ||
        run.status === "reconciliation_required" ||
        run.bindings.cleanupFailed
      )
        throw new Error(
          "Controlled publication trial journal changed or contains uncertainty",
        );
      records.set(trial.runId, { trial, run, events });
    }
    const allIds = [...inference.pairs, ...approval.heldoutPairs]
      .flatMap((pair: any) => [pair.positiveRunId, pair.negativeRunId])
      .concat(approval.positiveTests, approval.negativeGuardIds);
    if (
      new Set(allIds).size !== allIds.length ||
      records.size !== allIds.length ||
      allIds.some((id) => !records.has(id))
    )
      throw new Error("Controlled publication trial set is incomplete");
    for (const id of approval.positiveTests) {
      const { trial, run } = records.get(id);
      if (
        trial.phase !== "guard" ||
        trial.condition !== true ||
        run.status !== "succeeded" ||
        run.skill !== skill.id ||
        run.bindings.skillHash !== skill.hash
      )
        throw new Error(
          "Controlled publication positive is not an exact candidate test",
        );
    }
    for (const id of approval.negativeGuardIds) {
      const { trial, run, events } = records.get(id);
      const conditions = events.filter(
        (event: any) => event.type === "preconditions",
      );
      if (
        trial.phase !== "guard" ||
        trial.condition !== false ||
        run.status !== "blocked" ||
        run.skill !== skill.id ||
        run.bindings.skillHash !== skill.hash ||
        conditions.length !== 1 ||
        conditions[0].data.observation.facts[inference.fact] !== false ||
        !conditions[0].data.predicates.includes(inference.fact) ||
        events.some((event: any) =>
          [
            "requested",
            "authorized",
            "dispatched",
            "acknowledged",
            "experience",
          ].includes(event.type),
        )
      )
        throw new Error(
          "Controlled publication negative must stop before every action",
        );
    }
  }
  rollback(id: string, hashId: string) {
    const old = this.store.get<SkillCapsule>("skill-versions", hashId);
    if (!old || old.id !== id) throw new Error("Unknown skill version");
    this.put(old);
    return old;
  }
}
export function seedForm(): SkillCapsule {
  return seal({
    schemaVersion: 1,
    id: "form.seed",
    version: "1.0.0",
    hash: "",
    description: "Enter a display name in a resettable local form",
    status: "seed",
    inputs: { name: "string" },
    outputs: ["result"],
    capabilities: ["fill", "click"],
    preconditions: ["ready"],
    effects: ["edit"],
    machine: {
      initial: "edit",
      states: [
        {
          id: "edit",
          steps: [
            {
              id: "name",
              operation: "fill",
              args: { locator: "name", value: "$name" },
              scope: "edit",
            },
          ],
          next: "commit",
          monitor: ["focused"],
        },
        {
          id: "commit",
          steps: [
            {
              id: "commit",
              operation: "click",
              args: { locator: "apply" },
              scope: "edit",
            },
          ],
          monitor: ["focused"],
        },
      ],
    },
    recovery: ["observe", "probe", "repair", "escalate"],
    budgets: { retries: 1, steps: 8 },
    dependencies: [],
    compatibility: ["browser-fixture-v1"],
    descriptor: [1, 0, 0, 0, 0, 0, 0, 0],
    provenance: {
      kind: "hand_authored",
      demonstrations: [],
      tests: [],
      uncertain: [],
    },
  });
}
