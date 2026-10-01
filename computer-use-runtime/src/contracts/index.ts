import { Type, type Static } from "@sinclair/typebox";
import { Ajv } from "ajv";
const obj = <T extends Record<string, any>>(p: T) =>
  Type.Object(p, { additionalProperties: false });
const str = Type.String({ minLength: 1, maxLength: 8192 });
const dict = Type.Record(
  Type.String({ maxLength: 128 }),
  Type.Union([Type.String({ maxLength: 8192 }), Type.Number(), Type.Boolean()]),
);
const origin = Type.Union(
  [
    "user_explicit",
    "user_preference",
    "method_precondition",
    "environment_observation",
    "system_policy",
    "chosen_default",
    "unresolved",
  ].map((v) => Type.Literal(v)),
);
const frame = obj({
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
  scale: Type.Number({ exclusiveMinimum: 0 }),
});
export const TaskContractSchema = obj({
  schemaVersion: Type.Literal(1),
  id: str,
  correlationId: str,
  requester: str,
  goal: str,
  target: obj({ host: str, session: str, identity: str }),
  parameters: dict,
  effects: Type.Array(str, { maxItems: 32 }),
  requirements: Type.Array(obj({ name: str, value: str, origin }), {
    maxItems: 64,
  }),
  unresolved: Type.Array(str),
  method: Type.Optional(str),
  expected: dict,
  budgets: obj({
    steps: Type.Integer({ minimum: 1, maximum: 1000 }),
    deadlineMs: Type.Integer({ minimum: 100, maximum: 3600000 }),
  }),
});
export const ObservationSchema = obj({
  schemaVersion: Type.Literal(1),
  id: str,
  host: str,
  session: str,
  target: str,
  at: Type.Number(),
  revision: str,
  frame,
  focused: Type.Boolean(),
  facts: dict,
  image: Type.Optional(str),
  features: Type.Array(Type.Number()),
  backend: str,
  desktop: Type.Optional(
    obj({
      platform: str,
      activeWindow: Type.Optional(str),
      windows: Type.Array(
        obj({
          id: str,
          handle: Type.Integer(),
          pid: Type.Integer(),
          title: str,
          executable: str,
        }),
        { maxItems: 500 },
      ),
      apps: Type.Array(obj({ id: str, name: str }), { maxItems: 32 }),
    }),
  ),
  controls: Type.Optional(
    Type.Array(
      obj({
        index: Type.Integer(),
        id: Type.String(),
        name: Type.String(),
        value: Type.String(),
        controlType: Type.Integer(),
        focused: Type.Boolean(),
        offscreen: Type.Boolean(),
        actions: Type.Optional(Type.Array(Type.String())),
        selection: Type.Optional(Type.String()),
        bounds: obj({
          x: Type.Number(),
          y: Type.Number(),
          width: Type.Number(),
          height: Type.Number(),
        }),
      }),
      { maxItems: 500 },
    ),
  ),
});
export const ActionSchema = obj({
  schemaVersion: Type.Literal(1),
  id: str,
  runId: str,
  requester: str,
  host: str,
  session: str,
  target: str,
  observationId: str,
  revision: str,
  frame,
  operation: str,
  args: dict,
  deadline: Type.Number(),
  scope: str,
  generation: Type.Integer({ minimum: 1 }),
});
export const ReceiptSchema = obj({
  dispatched: Type.Optional(Type.Boolean()),
  schemaVersion: Type.Literal(1),
  actionId: str,
  runId: str,
  backend: str,
  at: Type.Number(),
  phase: Type.Union(
    [
      "requested",
      "authorized",
      "dispatched",
      "acknowledged",
      "effect_verified",
      "uncertain",
      "rejected",
    ].map((v) => Type.Literal(v)),
  ),
  detail: str,
  timings: Type.Record(Type.String(), Type.Number()),
});
export const PredicateEvidenceSchema = obj({
  schemaVersion: Type.Literal(1),
  id: str,
  predicate: str,
  truth: Type.Union(["TRUE", "FALSE", "UNKNOWN"].map((v) => Type.Literal(v))),
  kind: Type.Union(
    ["operational", "completion", "knowledge", "semantic"].map((v) =>
      Type.Literal(v),
    ),
  ),
  scope: str,
  observationId: str,
  references: Type.Array(str),
  at: Type.Number(),
  expiresAt: Type.Number(),
  invalidatedBy: Type.Array(str),
  detector: str,
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});
export const StepSchema = obj({
  id: str,
  operation: str,
  args: dict,
  scope: str,
  guard: Type.Optional(str),
  verify: Type.Optional(str),
  waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 })),
  waitFor: Type.Optional(str),
  alternatives: Type.Optional(Type.Array(str)),
  subskill: Type.Optional(str),
});
export const SkillCapsuleSchema = obj({
  schemaVersion: Type.Literal(1),
  id: str,
  version: str,
  hash: Type.String(),
  description: str,
  status: Type.Union(
    ["seed", "draft", "published", "quarantined"].map((v) => Type.Literal(v)),
  ),
  inputs: Type.Record(
    Type.String(),
    Type.Union(["string", "number", "boolean"].map((v) => Type.Literal(v))),
  ),
  outputs: Type.Array(str),
  capabilities: Type.Array(str),
  preconditions: Type.Array(str),
  effects: Type.Array(str),
  machine: obj({
    initial: str,
    onVerificationError: Type.Optional(str),
    states: Type.Array(
      obj({
        id: str,
        steps: Type.Array(StepSchema),
        next: Type.Optional(str),
        transitions: Type.Optional(
          Type.Array(obj({ guard: str, target: str }), { maxItems: 32 }),
        ),
        onError: Type.Optional(str),
        monitor: Type.Array(str),
      }),
      { minItems: 1, maxItems: 100 },
    ),
  }),
  recovery: Type.Array(str),
  budgets: obj({
    retries: Type.Integer({ minimum: 0, maximum: 5 }),
    steps: Type.Integer({ minimum: 1, maximum: 1000 }),
  }),
  dependencies: Type.Array(str),
  compatibility: Type.Array(str),
  descriptor: Type.Array(Type.Number()),
  provenance: obj({
    kind: Type.Union(["hand_authored", "compiled"].map((v) => Type.Literal(v))),
    demonstrations: Type.Array(str),
    tests: Type.Array(str),
    uncertain: Type.Array(str),
  }),
});
export const RunEventSchema = obj({
  schemaVersion: Type.Literal(1),
  seq: Type.Integer(),
  runId: str,
  correlationId: str,
  at: Type.Number(),
  type: str,
  data: Type.Unknown(),
});
export const ProviderCapabilitiesSchema = obj({
  schemaVersion: Type.Literal(1),
  id: str,
  modalities: Type.Array(str),
  structuredOutput: Type.Boolean(),
  tools: Type.Boolean(),
  cancellation: Type.Boolean(),
  local: Type.Boolean(),
  maxTokens: Type.Integer(),
  available: Type.Boolean(),
});
export const ModelVersionSchema = obj({
  schemaVersion: Type.Literal(1),
  id: str,
  hash: str,
  parameters: Type.Integer(),
  format: str,
  seed: Type.Integer(),
  status: Type.Union(
    ["candidate", "active", "retired"].map((v) => Type.Literal(v)),
  ),
  metrics: Type.Record(Type.String(), Type.Number()),
});
export const schemas = {
  TaskContract: TaskContractSchema,
  Observation: ObservationSchema,
  Action: ActionSchema,
  Receipt: ReceiptSchema,
  PredicateEvidence: PredicateEvidenceSchema,
  SkillCapsule: SkillCapsuleSchema,
  RunEvent: RunEventSchema,
  ProviderCapabilities: ProviderCapabilitiesSchema,
  ModelVersion: ModelVersionSchema,
};
const ajv = new Ajv({ allErrors: true, strict: false });
const validators = Object.fromEntries(
  Object.entries(schemas).map(([key, schema]) => [key, ajv.compile(schema)]),
);
export function validate<T>(name: keyof typeof schemas, value: unknown): T {
  if (!validators[name](value))
    throw new Error(
      `Invalid ${name}: ${ajv.errorsText(validators[name].errors)}`,
    );
  return value as T;
}
export type TaskContract = Static<typeof TaskContractSchema>;
export type Observation = Static<typeof ObservationSchema>;
export type Action = Static<typeof ActionSchema>;
export type Receipt = Static<typeof ReceiptSchema>;
export type PredicateEvidence = Static<typeof PredicateEvidenceSchema>;
export type SkillCapsule = Static<typeof SkillCapsuleSchema>;
export type Step = Static<typeof StepSchema>;
export type RunEvent = Static<typeof RunEventSchema>;
export type ProviderCapabilities = Static<typeof ProviderCapabilitiesSchema>;
export type ModelVersion = Static<typeof ModelVersionSchema>;
