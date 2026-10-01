import type {
  SkillCapsule,
  TaskContract,
  Observation,
} from "../contracts/index.js";
import { canonical, hash } from "../util/canonical.js";
import { compileProgram } from "../runtime/program.js";

export const PROGRAM_DESCRIPTOR_VERSION = 2;
export function programClosure(
  skill: SkillCapsule,
  lookup: (id: string) => SkillCapsule,
) {
  const closure: { id: string; hash: string }[] = [],
    visiting = new Set<string>(),
    seen = new Set<string>();
  function visit(current: SkillCapsule, depth: number) {
    if (
      depth > 16 ||
      visiting.has(current.id) ||
      hash(canonical({ ...current, hash: "" })) !== current.hash
    )
      throw new Error("Program closure is cyclic, too deep or changed");
    if (seen.has(current.id)) return;
    visiting.add(current.id);
    closure.push({ id: current.id, hash: current.hash });
    for (const child of current.machine.states
      .flatMap((state) => state.steps)
      .filter((step) => step.subskill)
      .map((step) => step.subskill!))
      visit(lookup(child), depth + 1);
    visiting.delete(current.id);
    seen.add(current.id);
  }
  visit(skill, 0);
  return closure;
}
export function programDescriptor(
  skill: SkillCapsule,
  lookup: (id: string) => SkillCapsule,
): number[] {
  const visiting = new Set<string>();
  function normalized(current: SkillCapsule, depth: number): unknown {
    if (depth > 16 || visiting.has(current.hash))
      throw new Error("Descriptor dependency cycle or depth exceeded");
    visiting.add(current.hash);
    const positions = new Map(
      current.machine.states.map((state, index) => [state.id, index]),
    );
    const value = {
      inputs: current.inputs,
      outputs: [...current.outputs].sort(),
      capabilities: [...current.capabilities].sort(),
      effects: [...current.effects].sort(),
      preconditions: [...current.preconditions].sort(),
      budgets: current.budgets,
      recovery: current.recovery,
      initial: positions.get(current.machine.initial),
      onVerificationError: current.machine.onVerificationError
        ? positions.get(current.machine.onVerificationError)
        : undefined,
      states: current.machine.states.map((state) => ({
        next: state.next ? positions.get(state.next) : undefined,
        onError: state.onError ? positions.get(state.onError) : undefined,
        monitor: state.monitor,
        transitions: state.transitions?.map((transition) => ({
          ...transition,
          target: positions.get(transition.target),
        })),
        steps: state.steps.map((step) => ({
          ...step,
          id: undefined,
          subskill: undefined,
          args: step.args,
          waitFor: step.waitFor,
          child: step.subskill
            ? normalized(lookup(step.subskill), depth + 1)
            : undefined,
        })),
      })),
    };
    visiting.delete(current.hash);
    return value;
  }
  const digest = hash(canonical(normalized(skill, 0)));
  return [
    ...skill.descriptor
      .slice(0, 4)
      .map((value) => Math.max(-1, Math.min(1, value))),
    ...Array.from(
      { length: 4 },
      (_, index) =>
        (parseInt(digest.slice(index * 8, index * 8 + 8), 16) / 0xffffffff) *
          2 -
        1,
    ),
  ];
}

export function applicableProgram(
  skill: SkillCapsule,
  task: TaskContract,
  observation: Observation,
  capabilities: readonly string[],
  lookup: (id: string) => SkillCapsule,
): boolean {
  if (
    !["seed", "published"].includes(skill.status) ||
    !skill.compatibility.includes(observation.target) ||
    !skill.effects.every((effect) => task.effects.includes(effect)) ||
    !skill.capabilities.every((operation) =>
      capabilities.includes(operation),
    ) ||
    !Object.entries(skill.inputs).every(
      ([key, type]) => typeof task.parameters[key] === type,
    ) ||
    !skill.preconditions.every(
      (predicate) => observation.facts[predicate] === true,
    ) ||
    !Object.keys(task.expected).every((key) => skill.outputs.includes(key))
  )
    return false;
  try {
    compileProgram(skill, task, [...capabilities], lookup);
    return true;
  } catch {
    return false;
  }
}
