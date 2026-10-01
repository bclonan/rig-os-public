import { readFileSync } from "node:fs";
import type {
  TaskContract,
  Observation,
  SkillCapsule,
} from "../contracts/index.js";
import { seedForm, seal } from "../skills/index.js";
import type { SkillRepository } from "../contracts/ports.js";
import { canonical, hash, type Store } from "../storage/index.js";
import { Controller } from "./index.js";
import {
  productionContext,
  CONTEXT_VERSION,
  ADVISORY_CONTEXT_VERSION,
  VISUAL_CONTEXT_VERSION,
} from "./context.js";
import { screenshotTensor } from "./image.js";
import {
  programDescriptor,
  programClosure,
  PROGRAM_DESCRIPTOR_VERSION,
} from "./descriptor.js";
import { compileProgram } from "../runtime/program.js";

type Prediction = Awaited<ReturnType<Controller["rank"]>>;
export function qualifiedProgramForecast(
  qualification: import("./qualification.js").FollowupQualification | undefined,
  descriptorVersion: number,
  skill: SkillCapsule | undefined,
  lookup?: (id: string) => SkillCapsule,
) {
  const rootKnown =
    !!skill &&
    !!qualification &&
    (qualification.candidateDescriptorVersion || 1) === descriptorVersion &&
    qualification.skillTemplates.includes(
      hash(canonical({ ...skill, hash: "", compatibility: [] })),
    );
  if (!rootKnown || !skill || !qualification) return false;
  if (descriptorVersion !== PROGRAM_DESCRIPTOR_VERSION) return true;
  if (!lookup) return false;
  const template = hash(canonical({ ...skill, hash: "", compatibility: [] }));
  const binding = qualification.programBindings?.find(
    (program) => program.template === template,
  );
  try {
    return (
      !!binding &&
      canonical(binding.closure) === canonical(programClosure(skill, lookup))
    );
  } catch {
    return false;
  }
}
export type ModelAdvice = {
  authority: string;
  predicates: Record<"ready" | "closed" | "dialog", number>;
  recovery: string;
  clarificationRecommended: boolean;
};
export type AdvisoryAssessment =
  | { available: false; model: string; reason: string }
  | {
      available: true;
      model: string;
      observationId: string;
      contextVersion: 3 | 4;
      historyActionIds: string[];
      advice: ModelAdvice;
      forecast: { available: false; reason: string };
      inferenceMs: number;
    };

function adviceFrom(prediction: Prediction): ModelAdvice {
  const recovery = prediction.recovery.indexOf(
    Math.max(...prediction.recovery),
  );
  return {
    authority:
      "advisory only; deterministic runtime predicates and effect verification remain authoritative",
    predicates: {
      ready: 1 / (1 + Math.exp(-prediction.predicates[0])),
      closed: 1 / (1 + Math.exp(-prediction.predicates[1])),
      dialog: 1 / (1 + Math.exp(-prediction.predicates[2])),
    },
    recovery: [
      "fresh observation",
      "permitted probe",
      "known local repair",
      "clarification or escalation",
    ][recovery],
    clarificationRecommended: recovery === 3,
  };
}

export function repairSkills(): SkillCapsule[] {
  return [
    ["repair.open", "open", 1],
    ["repair.dismiss", "dismiss", 2],
  ].map(([id, locator, axis]) =>
    seal({
      ...seedForm(),
      id: String(id),
      description: "Local repair " + locator,
      inputs: {},
      outputs: [],
      capabilities: ["click"],
      preconditions: [],
      machine: {
        initial: "repair",
        states: [
          {
            id: "repair",
            steps: [
              {
                id: "repair",
                operation: "click",
                args: { locator: String(locator) },
                scope: "edit",
              },
            ],
            monitor: ["focused"],
          },
        ],
      },
      descriptor: Array.from({ length: 8 }, (_, i) => Number(i === axis)),
    }),
  );
}
export function repairComposition(
  form: SkillCapsule,
  children: SkillCapsule[],
  descriptor: number[],
): SkillCapsule {
  return seal({
    ...form,
    id:
      "plan." +
      hash(children.map((child) => child.hash).join("|")).slice(0, 12),
    version: "1.0.0",
    hash: "",
    status: "seed",
    description: "Bounded compatible repair composition",
    preconditions: [],
    dependencies: children.map((child) => child.id),
    capabilities: [...new Set(children.flatMap((child) => child.capabilities))],
    descriptor,
    machine: {
      initial: "compose",
      states: [
        {
          id: "compose",
          steps: children.map((child, index) => ({
            id: "child" + index,
            operation: "subskill" as const,
            subskill: child.id,
            args: {},
            scope: "edit" as const,
          })),
          monitor: ["focused"],
        },
      ],
    },
    provenance: {
      kind: "hand_authored",
      demonstrations: [],
      tests: [],
      uncertain: [],
    },
  });
}

export class AdaptiveSelector {
  private controller?: Controller;
  private loaded = "";
  constructor(
    private store: Store,
    private capabilities?: readonly string[],
  ) {}
  async assess(
    task: TaskContract,
    o: Observation,
  ): Promise<AdvisoryAssessment> {
    const run = this.store.run(task.id);
    if (canonical(run.contract) !== canonical(task))
      throw new Error("Assessment must use the run's pinned task contract");
    if (
      task.target.host !== o.host ||
      task.target.session !== o.session ||
      task.target.identity !== o.target
    )
      throw new Error("Assessment observation belongs to another task target");
    const active = run.model;
    const model = this.store.get<import("../contracts/index.js").ModelVersion>(
      "models",
      active,
    );
    const qualification = model
      ? this.store.get<{
          qualification: import("./qualification.js").FollowupQualification;
        }>("model-qualifications", model.hash)?.qualification
      : undefined;
    if (
      !model ||
      ![ADVISORY_CONTEXT_VERSION, VISUAL_CONTEXT_VERSION].includes(
        model.metrics.contextVersion,
      ) ||
      !qualification ||
      qualification.contextVersion !== model.metrics.contextVersion ||
      (qualification.candidateDescriptorVersion || 1) !==
        (model.metrics.candidateDescriptorVersion || 1) ||
      (model.metrics.contextVersion === VISUAL_CONTEXT_VERSION &&
        !qualification.visualStateQualified) ||
      qualification.track !== "browser" ||
      o.target !== "browser-fixture-v1" ||
      !["predicates", "recovery", "clarification", "outcome_cost"].every(
        (capability) =>
          qualification.learnedCapabilities.includes(
            capability as
              "predicates" | "recovery" | "clarification" | "outcome_cost",
          ),
      ) ||
      !qualification.models.some(
        (candidate) =>
          candidate.seed === model.seed && candidate.sha256 === model.hash,
      )
    )
      return {
        available: false,
        model: active,
        reason:
          "The pinned model has no full-head qualification for this target",
      };
    const path = this.store.get<string>("model-path", active);
    if (!path || hash(readFileSync(path)) !== model.hash)
      throw new Error("Pinned assessment model artifact is missing or changed");
    const { context, previous } = productionContext(
      this.store,
      task,
      o,
      undefined,
      model.metrics.contextVersion,
    );
    // A separate CPU session avoids replacing a selector used by an active run.
    // No action is proposed here, so forecasts of an action's effects stay hidden.
    const controller = await Controller.load(path);
    try {
      const prediction = await controller.rank(
        o,
        [{ descriptor: [0, 0, 0, 1, 0, 0, 0, 0] }],
        context,
        model.metrics.contextVersion === VISUAL_CONTEXT_VERSION
          ? o.image
            ? screenshotTensor(this.store.artifactRead(o.image))
            : (() => {
                throw new Error(
                  "Visual assessment requires an actual BEFORE image",
                );
              })()
          : undefined,
      );
      return {
        available: true,
        model: active,
        observationId: o.id,
        contextVersion: model.metrics.contextVersion as 3 | 4,
        historyActionIds: previous.slice(-2).map((entry) => entry.action.id),
        advice: adviceFrom(prediction),
        forecast: {
          available: false,
          reason:
            "No legal action was proposed during this read-only assessment",
        },
        inferenceMs: prediction.latencyMs,
      };
    } finally {
      await controller.close();
    }
  }
  async select(task: TaskContract, o: Observation, registry: SkillRepository) {
    if (
      task.target.host !== o.host ||
      task.target.session !== o.session ||
      task.target.identity !== o.target
    )
      throw new Error("Candidate observation belongs to another task target");
    const active = this.store.run(task.id).model;
    const model = this.store.get<import("../contracts/index.js").ModelVersion>(
      "models",
      active,
    );
    const qualification = model
      ? this.store.get<{
          qualification: import("./qualification.js").FollowupQualification;
        }>("model-qualifications", model.hash)?.qualification
      : undefined;
    if (
      active !== "fixed" &&
      o.target !== "browser-fixture-v1" &&
      (!qualification ||
        qualification.track !== "native" ||
        process.platform !== "win32" ||
        o.backend !== "rust-win32-v1" ||
        o.facts.desktopPlatform !== "Windows" ||
        !Number.isInteger(o.facts.windowPid) ||
        Number(o.facts.windowPid) <= 0 ||
        typeof o.facts.windowExecutable !== "string" ||
        !/[\\/]disposable-editor\.exe$/i.test(o.facts.windowExecutable) ||
        o.facts.windowExecutableSha256 !==
          qualification.nativeExecutableSha256 ||
        o.facts.windowTitle !== "Computer use disposable editor")
    )
      throw new Error(
        "Owned model has no qualification for this native environment",
      );
    const validProgram = (skill: SkillCapsule) => {
      try {
        compileProgram(
          skill,
          task,
          this.capabilities
            ? [...this.capabilities]
            : [
                ...new Set(
                  registry
                    .list()
                    .flatMap((candidate) => candidate.capabilities),
                ),
              ],
          (id) => registry.get(id),
        );
        return true;
      } catch {
        return false;
      }
    };
    const applicable = (skill: SkillCapsule, preconditions = true) =>
      ["seed", "published"].includes(skill.status) &&
      skill.compatibility.includes(o.target) &&
      skill.effects.every((effect) => task.effects.includes(effect)) &&
      (!this.capabilities ||
        skill.capabilities.every((operation) =>
          this.capabilities!.includes(operation),
        )) &&
      Object.entries(skill.inputs).every(
        ([key, type]) => typeof task.parameters[key] === type,
      ) &&
      (!preconditions ||
        skill.preconditions.every(
          (predicate) => o.facts[predicate] === true,
        )) &&
      (!qualification ||
        qualification.track !== "native" ||
        qualification.skillTemplates.includes(
          hash(canonical({ ...skill, hash: "", compatibility: [] })),
        )) &&
      validProgram(skill);
    const matchesOutcome = (skill: SkillCapsule) =>
      Object.keys(task.expected).every((key) => skill.outputs.includes(key));
    const base = registry
      .list()
      .filter((skill) => applicable(skill, false) && matchesOutcome(skill))
      .sort(
        (a, b) =>
          Number(b.provenance.kind === "compiled") -
            Number(a.provenance.kind === "compiled") ||
          a.id.localeCompare(b.id),
      );
    const candidates: SkillCapsule[] = [];
    for (const skill of base) if (applicable(skill)) candidates.push(skill);
    // Compatibility repair compositions remain a hand-authored browser fallback.
    // Every compiled workflow, including a new input schema, competes by its descriptor.
    if (o.target === "browser-fixture-v1") {
      const repairs = repairSkills();
      for (const skill of repairs)
        if (!registry.list().some((s) => s.id === skill.id))
          registry.put(skill);
      for (const form of base.filter(
        (s) => s.inputs.name === "string" && s.preconditions.includes("ready"),
      )) {
        const choice =
          o.facts.dialog === true ? 2 : o.facts.closed === true ? 1 : 0;
        if (!choice) continue;
        const ids =
          choice === 1
            ? [repairs[0].id, form.id]
            : [
                repairs[1].id,
                ...(o.facts.closed === true ? [repairs[0].id] : []),
                form.id,
              ];
        if (ids.some((id) => !applicable(registry.get(id), false))) continue;
        candidates.push(
          repairComposition(
            form,
            ids.map((id) => registry.get(id)),
            repairs[choice - 1].descriptor,
          ),
        );
      }
    }
    if (!candidates.length)
      throw new Error(
        "No compatible published skill satisfies typed inputs, capabilities, permission and known preconditions",
      );
    const descriptorVersion = model?.metrics.candidateDescriptorVersion || 1;
    const skills = [
      ...candidates.map((candidate) =>
        descriptorVersion === PROGRAM_DESCRIPTOR_VERSION
          ? {
              descriptor: programDescriptor(candidate, (id) =>
                registry.get(id),
              ),
            }
          : candidate,
      ),
      { descriptor: [0, 0, 0, 1, 0, 0, 0, 0] },
    ];
    let choice: number;
    if (active === "fixed") choice = 0;
    else {
      if (this.loaded !== active) {
        await this.controller?.close();
        const path = this.store.get<string>("model-path", active);
        if (!path) throw new Error("Active model artifact missing");
        const model = this.store.get<
          import("../contracts/index.js").ModelVersion
        >("models", active);
        if (!model || hash(readFileSync(path)) !== model.hash)
          throw new Error("Active model artifact changed");
        this.controller = await Controller.load(path);
        this.loaded = active;
      }
      const version = model?.metrics.contextVersion || 1;
      const { previous, context } = productionContext(
        this.store,
        task,
        o,
        undefined,
        version,
      );
      const liveContext = [
        CONTEXT_VERSION,
        ADVISORY_CONTEXT_VERSION,
        VISUAL_CONTEXT_VERSION,
      ].includes(version);
      const pixels =
        o.target === "browser-fixture-v1" && version !== VISUAL_CONTEXT_VERSION
          ? undefined
          : o.image
            ? screenshotTensor(this.store.artifactRead(o.image))
            : undefined;
      if (
        (o.target !== "browser-fixture-v1" ||
          version === VISUAL_CONTEXT_VERSION) &&
        !pixels
      )
        throw new Error("Owned selection requires a captured target image");
      const prediction = await this.controller!.rank(
        o,
        skills,
        liveContext ? context : undefined,
        pixels,
      );
      choice = prediction.index;
      const forecastQualified = qualifiedProgramForecast(
        qualification,
        descriptorVersion,
        candidates[choice],
        (id) => registry.get(id),
      );
      this.store.append(
        task.id,
        "controller_prediction",
        {
          model: active,
          prediction,
          observationId: o.id,
          contextVersion: liveContext ? version : 1,
          ...([ADVISORY_CONTEXT_VERSION, VISUAL_CONTEXT_VERSION].includes(
            version,
          )
            ? {
                advice: {
                  ...adviceFrom(prediction),
                  forecastAvailable: forecastQualified,
                  ...(forecastQualified
                    ? {
                        successForecast: prediction.outcome[0],
                        normalizedCostForecast: prediction.outcome[1],
                      }
                    : {
                        forecastReason:
                          "No tested immutable program template for this proposal",
                      }),
                },
              }
            : {}),
          historyActionIds: liveContext
            ? previous.slice(-2).map((p) => p.action.id)
            : [],
          context: liveContext ? Array.from(context) : undefined,
          image: o.image,
          candidateHashes: candidates.map((s) => s.hash),
          candidateDescriptorVersion: descriptorVersion,
          candidateDescriptors: skills
            .slice(0, candidates.length)
            .map((skill) => skill.descriptor),
          masksAppliedBeforeRanking: true,
        },
        task.correlationId,
      );
    }
    if (choice === candidates.length)
      throw new Error(
        "Controller abstained. A fresh observation or user correction is needed.",
      );
    const selected = candidates[choice];
    if (!selected || !applicable(selected))
      throw new Error("Selected candidate failed its deterministic mask");
    return selected;
  }
  async close() {
    await this.controller?.close();
  }
}
