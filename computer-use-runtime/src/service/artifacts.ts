import type { TaskContract, SkillCapsule, Step } from "../contracts/index.js";
import type { ArtifactSpec } from "../assistant/artifact.js";
import { freezeArtifactSpec } from "../assistant/artifact.js";
import type { WorkspaceAdapter } from "../adapters/workspace.js";
import { seal } from "../skills/index.js";

export type ArtifactConfiguration = {
  spec: ArtifactSpec;
  model: string;
  input?: string;
};
export function artifactConfiguration(value: unknown): ArtifactConfiguration {
  const input = value as ArtifactConfiguration;
  if (
    !input ||
    typeof input.model !== "string" ||
    !input.model ||
    input.model.length > 200 ||
    Object.keys(input).some((key) => !["spec", "model", "input"].includes(key))
  )
    throw new Error("Choose a local model and frozen artifact criteria");
  const spec = freezeArtifactSpec(input.spec);
  if (
    spec.source.operation === "workspace_read" &&
    (typeof input.input !== "string" || Buffer.byteLength(input.input) > 262144)
  )
    throw new Error("Paste a source document of at most 262144 UTF-8 bytes");
  if (spec.source.operation === "research_read" && input.input !== undefined)
    throw new Error(
      "Research tasks retrieve the frozen URL instead of pasted input",
    );
  return structuredClone({
    spec,
    model: input.model,
    ...(input.input === undefined ? {} : { input: input.input }),
  });
}
export function artifactSkill(adapter: WorkspaceAdapter): SkillCapsule {
  const source = adapter.constructorAgent.spec.source;
  const sourceStep: Step = {
    id: "source",
    operation: source.operation,
    scope: source.operation,
    args:
      source.operation === "research_read"
        ? { url: source.location }
        : { path: source.location },
    verify: "sourceReady",
  };
  return seal({
    schemaVersion: 1,
    id: "artifact." + adapter.constructorAgent.configHash,
    version: "1.0.0",
    hash: "",
    description:
      "Construct and independently verify the frozen artifact criteria",
    status: "seed",
    inputs: { configHash: "string" },
    outputs: ["artifactValid"],
    capabilities: [source.operation, "construct_artifact", "repair_artifact"],
    preconditions: ["ready"],
    effects: [
      ...new Set([source.operation, "workspace_read", "workspace_write"]),
    ],
    machine: {
      initial: "construct",
      onVerificationError: "repair",
      states: [
        {
          id: "construct",
          monitor: ["ready"],
          steps: [
            sourceStep,
            {
              id: "construct",
              operation: "construct_artifact",
              args: {},
              scope: "workspace_write",
            },
          ],
        },
        {
          id: "repair",
          monitor: ["ready"],
          steps: [
            {
              id: "repair",
              operation: "repair_artifact",
              args: {},
              scope: "workspace_write",
            },
          ],
        },
      ],
    },
    recovery: ["independent_failure_diff", "bounded_repair", "escalate"],
    budgets: { retries: 2, steps: 5 },
    dependencies: [],
    compatibility: [adapter.identity],
    descriptor: [0, 0, 0, 0, 0, 1, 0, 0],
    provenance: {
      kind: "hand_authored",
      demonstrations: [],
      tests: [],
      uncertain: [],
    },
  });
}
export function artifactTask(
  id: string,
  correlationId: string,
  goal: string,
  adapter: WorkspaceAdapter,
): TaskContract {
  const skill = artifactSkill(adapter);
  return {
    schemaVersion: 1,
    id,
    correlationId,
    requester: "local-user",
    goal,
    target: {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    parameters: { configHash: adapter.constructorAgent.configHash },
    effects: skill.effects,
    requirements: [
      {
        name: "artifact",
        value: JSON.stringify(adapter.constructorAgent.spec),
        origin: "user_explicit",
      },
    ],
    unresolved: [],
    method: skill.id,
    expected: { artifactValid: true },
    budgets: { steps: 5, deadlineMs: 300000 },
  };
}
