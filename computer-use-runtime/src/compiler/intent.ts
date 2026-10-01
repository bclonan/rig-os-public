import { randomUUID } from "node:crypto";
import {
  TaskContractSchema,
  validate,
  type TaskContract,
  type SkillCapsule,
} from "../contracts/index.js";
import type { ModelProvider } from "../contracts/ports.js";
export function structuredTask(
  goal: string,
  target: TaskContract["target"],
  parameters: TaskContract["parameters"],
  method = "form.seed",
): TaskContract {
  return {
    schemaVersion: 1,
    id: randomUUID(),
    correlationId: randomUUID(),
    requester: "local-user",
    goal,
    target,
    parameters,
    effects: ["edit"],
    requirements: [{ name: "outcome", value: goal, origin: "user_explicit" }],
    unresolved: [],
    method,
    expected: { result: parameters.name || "" },
    budgets: { steps: 8, deadlineMs: 15000 },
  };
}
export async function compileIntent(
  goal: string,
  target: TaskContract["target"],
  effects: string[],
  skills: SkillCapsule[],
  provider: ModelProvider,
  signal?: AbortSignal,
): Promise<TaskContract> {
  if (!provider.capabilities.available)
    throw new Error("No available local language provider");
  // Pass A establishes intent without letting the provider increase authority.
  const prompt = `Compile this user goal into a TaskContract. Goal: ${JSON.stringify(goal)}. Target must be exactly ${JSON.stringify(target)}. Requester local-user. Use schemaVersion 1, unique id and correlationId, budgets steps 20 deadlineMs 60000. The externally authorized effects are ${JSON.stringify(effects)}; do not increase them. Distinguish user_explicit, chosen_default, unresolved requirements. Saving, sending, uploading are never implicit. Unsupported outcomes must be unresolved, not replaced by a demo. Registered methods: ${JSON.stringify(skills.map((s) => ({ id: s.id, description: s.description, inputs: s.inputs, outputs: s.outputs, preconditions: s.preconditions })))}. For the local form use parameters.name and expected.result with the exact requested display name. A recognizable dog is a semantic outcome distinct from canvas changed. Return the contract.`;
  const task = validate<TaskContract>(
    "TaskContract",
    await provider.generate(prompt, TaskContractSchema, signal),
  );
  task.id = randomUUID();
  task.correlationId = randomUUID();
  task.requester = "local-user";
  task.goal = goal;
  if (JSON.stringify(task.target) !== JSON.stringify(target)) {
    if (
      task.target.host !== target.host ||
      task.target.session !== target.session ||
      task.target.identity !== target.identity
    )
      throw new Error("Provider changed target");
  }
  if (task.effects.some((x) => !effects.includes(x)))
    throw new Error("Provider expanded authority");
  for (const requirement of task.requirements) {
    if (requirement.origin !== "unresolved") continue;
    const question =
      "Unresolved requirement: " + requirement.name + ": " + requirement.value;
    if (!task.unresolved.includes(question)) task.unresolved.push(question);
  }
  // Pass B resolves method-specific requirements. These never become user intent.
  const selected = skills.find((s) => s.id === task.method);
  if (!selected)
    task.unresolved.push("No compatible registered method for this outcome");
  else {
    const prerequisites = new Set<string>();
    const expand = (skill: SkillCapsule, path: string[]) => {
      if (path.includes(skill.id) || path.length >= 8)
        throw new Error("Recursive method prerequisite rejected");
      if (!skill.compatibility.includes(target.identity))
        task.unresolved.push(
          "Method is incompatible with the selected target: " + skill.id,
        );
      if (skill.effects.some((effect) => !effects.includes(effect)))
        task.unresolved.push(
          "Method requires an unauthorized effect: " + skill.id,
        );
      skill.preconditions.forEach((predicate) => prerequisites.add(predicate));
      for (const id of skill.dependencies) {
        const child = skills.find((candidate) => candidate.id === id);
        if (!child) task.unresolved.push("Missing prerequisite skill: " + id);
        else expand(child, [...path, skill.id]);
      }
    };
    expand(selected, []);
    for (const p of prerequisites)
      task.requirements.push({
        name: p,
        value: "Must verify against a fresh observation",
        origin: "method_precondition",
      });
  }
  return validate<TaskContract>("TaskContract", task);
}
