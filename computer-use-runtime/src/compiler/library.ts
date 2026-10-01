import type { SkillCapsule, Step } from "../contracts/index.js";
import type { Demonstration } from "../recorder/index.js";
import { canonical, hash } from "../storage/index.js";
import { seal, checkSkill } from "../skills/index.js";
import { compileDemonstrations } from "./experience.js";

export type WorkflowLibrary = {
  schemaVersion: 1;
  roots: SkillCapsule[];
  dependencies: SkillCapsule[];
  extractions: {
    dependency: string;
    methods: string[];
    operations: number;
    evidence: string[];
  }[];
};
const template = ({ id: _id, ...step }: Step) => canonical(step);

/** Extract common contiguous programs. Omitted or reordered effects never qualify. */
export function compileWorkflowLibrary(
  demos: Demonstration[],
  prefix = "library",
): WorkflowLibrary {
  if (!/^[a-zA-Z0-9_.-]{1,60}$/.test(prefix))
    throw new Error("Invalid library namespace");
  const groups = new Map<string, Demonstration[]>();
  for (const demo of demos) {
    const key = canonical({
      target: demo.contract.target.identity,
      method: demo.contract.method,
    });
    groups.set(key, [...(groups.get(key) || []), demo]);
  }
  if (groups.size < 2)
    throw new Error(
      "Reusable extraction needs at least two demonstrated method families",
    );
  const roots = [...groups.values()].map((group, index) =>
    compileDemonstrations(group, `${prefix}.method${index}`),
  );
  const programs = roots.map((root) =>
    root.machine.states.flatMap((state) => state.steps),
  );
  let best:
    | { sequence: Step[]; matches: { method: number; start: number }[] }
    | undefined;
  for (let method = 0; method < programs.length; method++) {
    for (let start = 0; start < programs[method].length - 1; start++) {
      for (
        let length = 2;
        start + length <= programs[method].length;
        length++
      ) {
        const sequence = programs[method].slice(start, start + length);
        const signature = sequence.map(template).join("\n");
        const matches = programs.flatMap((steps, index) => {
          const at = steps.findIndex(
            (_, i) =>
              i + length <= steps.length &&
              steps
                .slice(i, i + length)
                .map(template)
                .join("\n") === signature &&
              canonical(roots[index].inputs) ===
                canonical(roots[method].inputs) &&
              canonical(roots[index].compatibility) ===
                canonical(roots[method].compatibility),
          );
          return at < 0 ? [] : [{ method: index, start: at }];
        });
        if (matches.length >= 2 && (!best || length > best.sequence.length))
          best = { sequence, matches };
      }
    }
  }
  if (!best)
    throw new Error("No shared contiguous parameterized subflow found");
  const base = roots[best.matches[0].method];
  const usedInputs = [
    ...new Set(
      best.sequence.flatMap((step) =>
        Object.values(step.args)
          .filter(
            (value): value is string =>
              typeof value === "string" && value.startsWith("$"),
          )
          .map((value) => value.slice(1)),
      ),
    ),
  ];
  const sequence = best.sequence.map((step, index) => ({
    ...step,
    id: `shared${index}`,
  }));
  const dependency = seal({
    ...base,
    id: `${prefix}.shared.${hash(canonical(sequence)).slice(0, 12)}`,
    description:
      "Contiguous parameterized subflow shared by independently demonstrated methods",
    inputs: Object.fromEntries(
      usedInputs.map((name) => [name, base.inputs[name]]),
    ),
    capabilities: [...new Set(sequence.map((step) => step.operation))],
    effects: [...new Set(sequence.map((step) => step.scope))],
    dependencies: [],
    preconditions: [],
    machine: {
      initial: "shared",
      states: [{ id: "shared", steps: sequence, monitor: ["focused"] }],
    },
    budgets: { retries: 0, steps: sequence.length + 2 },
    provenance: {
      kind: "compiled" as const,
      demonstrations: best.matches.flatMap(
        (match) => roots[match.method].provenance.demonstrations,
      ),
      tests: [],
      uncertain: best.matches.flatMap(
        (match) => roots[match.method].provenance.uncertain,
      ),
    },
  });
  for (const match of best.matches) {
    const root = roots[match.method];
    const steps = programs[match.method];
    const call: Step = {
      id: "shared-call",
      operation: "subskill",
      subskill: dependency.id,
      args: Object.fromEntries(usedInputs.map((name) => [name, "$" + name])),
      scope: dependency.effects[0],
    };
    roots[match.method] = seal({
      ...root,
      dependencies: [dependency.id],
      machine: {
        initial: "workflow",
        states: [
          {
            id: "workflow",
            steps: [
              ...steps.slice(0, match.start),
              call,
              ...steps.slice(match.start + sequence.length),
            ],
            monitor: ["focused"],
          },
        ],
      },
    });
  }
  const result: WorkflowLibrary = {
    schemaVersion: 1,
    roots,
    dependencies: [dependency],
    extractions: [
      {
        dependency: dependency.id,
        methods: best.matches.map((match) => roots[match.method].id),
        operations: sequence.length,
        evidence: dependency.provenance.demonstrations,
      },
    ],
  };
  [...result.dependencies, ...result.roots].forEach(checkSkill);
  return result;
}

export function importWorkflowLibrary(value: unknown): WorkflowLibrary {
  const library = value as WorkflowLibrary;
  if (
    library?.schemaVersion !== 1 ||
    !Array.isArray(library.roots) ||
    !Array.isArray(library.dependencies) ||
    !Array.isArray(library.extractions) ||
    library.roots.length === 0 ||
    library.roots.length > 100 ||
    library.dependencies.length > 100
  )
    throw new Error("Unsupported workflow library schema");
  const skills = [...library.dependencies, ...library.roots].map(checkSkill);
  const ids = new Set(skills.map((skill) => skill.id));
  if (
    ids.size !== skills.length ||
    skills.some((skill) => skill.dependencies.some((id) => !ids.has(id)))
  )
    throw new Error("Workflow library has duplicate or missing dependencies");
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const roots = new Set(library.roots.map((skill) => skill.id));
  const dependencies = new Map(
    library.dependencies.map((skill) => [skill.id, skill]),
  );
  if (
    library.extractions.length > 100 ||
    library.extractions.some(
      (extraction) =>
        !extraction ||
        !dependencies.has(extraction.dependency) ||
        !Number.isSafeInteger(extraction.operations) ||
        extraction.operations < 2 ||
        extraction.operations > 120 ||
        !Array.isArray(extraction.methods) ||
        new Set(extraction.methods).size < 2 ||
        extraction.methods.some(
          (method) => typeof method !== "string" || !roots.has(method),
        ) ||
        !Array.isArray(extraction.evidence) ||
        extraction.evidence.some(
          (id) =>
            typeof id !== "string" ||
            !dependencies
              .get(extraction.dependency)!
              .provenance.demonstrations.includes(id),
        ),
    )
  )
    throw new Error("Workflow extraction references are invalid");
  const visit = (id: string, path: Set<string>) => {
    if (path.has(id) || path.size >= 8)
      throw new Error("Workflow library contains recursive dependencies");
    for (const child of byId.get(id)!.dependencies)
      visit(child, new Set([...path, id]));
  };
  skills.forEach((skill) => visit(skill.id, new Set()));
  return {
    ...library,
    roots: library.roots.map((skill) =>
      seal({ ...skill, status: "quarantined" }),
    ),
    dependencies: library.dependencies.map((skill) =>
      seal({ ...skill, status: "quarantined" }),
    ),
  };
}
