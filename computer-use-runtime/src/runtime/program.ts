import type { SkillCapsule, Step, TaskContract } from "../contracts/index.js";
import type { InvocationScope } from "./invocations.js";

export interface ProgramStep {
  key: string;
  step?: Step;
  monitors: string[];
  next?: string;
  branches: { guard: string; target: string }[];
  recovery?: string;
  budgetScopes: InvocationScope[];
  freshObservationRecovery: boolean;
  call?: {
    phase: "enter" | "return";
    scope: InvocationScope;
    guard?: string;
    verify?: string;
  };
}
export interface Program {
  initial: string;
  verificationRecovery?: string;
  nodes: Map<string, ProgramStep>;
  legacyOrder: string[];
}

// Compile portable control flow to XState node references. This does not execute it.
export function compileProgram(
  root: SkillCapsule,
  task: TaskContract,
  capabilities: string[],
  resolve: (id: string) => SkillCapsule,
  candidateHash?: string,
  candidateDependencies: ReadonlySet<string> = new Set(),
): Program {
  const nodes = new Map<string, ProgramStep>();
  const legacyOrder: string[] = [];
  function expand(
    skill: SkillCapsule,
    path: string,
    continuation?: string,
    inherited: string[] = [],
    bindings: Record<string, unknown> = task.parameters,
    stack: string[] = [],
    budgetScopes: InvocationScope[] = [],
    callerRecovery?: string,
    inheritedFreshRecovery = true,
  ): string {
    if (stack.length >= 8 || stack.includes(skill.id))
      throw new Error("Recursive subskill dependency rejected");
    if (
      !["seed", "published"].includes(skill.status) &&
      skill.hash !== candidateHash &&
      !candidateDependencies.has(skill.hash)
    )
      throw new Error("Unpublished subskill");
    if (!skill.compatibility.includes(task.target.identity))
      throw new Error("Subskill compatibility rejected");
    if (skill.effects.some((effect) => !task.effects.includes(effect)))
      throw new Error("Subskill permission scope rejected");
    for (const capability of skill.capabilities)
      if (!capabilities.includes(capability))
        throw new Error(`Missing capability ${capability}`);
    for (const [key, type] of Object.entries(skill.inputs))
      if (typeof bindings[key] !== type)
        throw new Error(`Invalid subskill parameter ${key}`);
    const key = (state: string) => `${path}/${encodeURIComponent(state)}`;
    const freshObservationRecovery =
      inheritedFreshRecovery && skill.recovery.includes("fresh_observation");
    const value = (v: unknown) =>
      typeof v === "string" && v.startsWith("$") ? bindings[v.slice(1)] : v;
    const visited = new Set<string>();
    function state(id: string) {
      if (visited.has(id)) return;
      if (nodes.size > 10000)
        throw new Error("Expanded program exceeds 10000 nodes");
      visited.add(id);
      const current = skill.machine.states.find((s) => s.id === id);
      if (!current) throw new Error("Missing state target");
      const monitors = [...new Set([...inherited, ...current.monitor])];
      const recovery = current.onError ? key(current.onError) : callerRecovery;
      const tail = current.transitions?.length
        ? key(id) + "/branch"
        : current.next
          ? key(current.next)
          : continuation;
      // State entry is an internal jump, not an adapter action or a policy observation.
      const first = current.steps.length ? key(id) + "/0" : tail;
      nodes.set(key(id), {
        key: key(id),
        monitors,
        next: first,
        branches: [],
        recovery,
        budgetScopes,
        freshObservationRecovery,
      });
      for (let index = 0; index < current.steps.length; index++) {
        const step = current.steps[index];
        const nodeKey = key(id) + "/" + index;
        const next =
          index + 1 < current.steps.length ? key(id) + "/" + (index + 1) : tail;
        if (step.subskill) {
          if (!skill.dependencies.includes(step.subskill))
            throw new Error("Undeclared subskill");
          const arguments_ = Object.fromEntries(
            Object.entries(step.args).map(([name, v]) => [name, value(v)]),
          );
          const childSkill = resolve(step.subskill);
          const childPath = nodeKey + "/child";
          const scope: InvocationScope = {
            id: childPath,
            hash: childSkill.hash,
            steps: childSkill.budgets.steps,
            retries: childSkill.budgets.retries,
          };
          const returnKey = nodeKey + "/return";
          nodes.set(returnKey, {
            key: returnKey,
            monitors,
            next,
            branches: [],
            recovery,
            budgetScopes: [...budgetScopes, scope],
            freshObservationRecovery,
            call: { phase: "return", scope, verify: step.verify },
          });
          const child = expand(
            childSkill,
            childPath,
            returnKey,
            monitors,
            { ...bindings, ...arguments_ },
            [...stack, skill.id],
            [...budgetScopes, scope],
            recovery,
            freshObservationRecovery,
          );
          nodes.set(nodeKey, {
            key: nodeKey,
            monitors,
            next: child,
            branches: [],
            recovery,
            budgetScopes,
            freshObservationRecovery,
            call: { phase: "enter", scope, guard: step.guard },
          });
        } else {
          const args = Object.fromEntries(
            Object.entries(step.args).map(([name, v]) => {
              const bound = value(v);
              if (!["string", "number", "boolean"].includes(typeof bound))
                throw new Error(`Unbound parameter ${String(v)}`);
              return [name, bound];
            }),
          ) as Step["args"];
          nodes.set(nodeKey, {
            key: nodeKey,
            step: { ...step, args },
            monitors,
            next,
            branches: [],
            recovery,
            budgetScopes,
            freshObservationRecovery,
          });
          legacyOrder.push(nodeKey);
        }
      }
      if (current.transitions?.length)
        nodes.set(tail!, {
          key: tail!,
          monitors,
          branches: current.transitions.map((t) => ({
            guard: t.guard,
            target: key(t.target),
          })),
          next: current.next ? key(current.next) : continuation,
          recovery,
          budgetScopes,
          freshObservationRecovery,
        });
      if (current.next) state(current.next);
      for (const branch of current.transitions || []) state(branch.target);
      if (current.onError) state(current.onError);
    }
    state(skill.machine.initial);
    if (skill.machine.onVerificationError)
      state(skill.machine.onVerificationError);
    if (stack.length && skill.preconditions.length) {
      const entry = path + "/preconditions";
      nodes.set(entry, {
        key: entry,
        monitors: [...new Set([...inherited, ...skill.preconditions])],
        next: key(skill.machine.initial),
        branches: [],
        budgetScopes,
        freshObservationRecovery,
        recovery: callerRecovery,
        step: {
          id: entry,
          operation: "observe",
          scope: skill.effects[0] || task.effects[0],
          args: {},
        },
      });
      // Older runtimes expanded child preconditions into leading observation steps.
      const childStart = legacyOrder.findIndex((k) => k.startsWith(path + "/"));
      legacyOrder.splice(
        childStart < 0 ? legacyOrder.length : childStart,
        0,
        entry,
      );
      return entry;
    }
    return key(skill.machine.initial);
  }
  const initial = expand(root, "root");
  return {
    initial,
    verificationRecovery: root.machine.onVerificationError
      ? `root/${encodeURIComponent(root.machine.onVerificationError)}`
      : undefined,
    nodes,
    legacyOrder,
  };
}
