import { randomUUID } from "node:crypto";
import type {
  Observation,
  PredicateEvidence,
  TaskContract,
} from "../contracts/index.js";
export function fact(
  o: Observation,
  key: string,
  expected: unknown = true,
  kind: PredicateEvidence["kind"] = "operational",
): PredicateEvidence {
  const value = o.facts[key];
  return {
    schemaVersion: 1,
    id: randomUUID(),
    predicate: key,
    truth:
      value === undefined ? "UNKNOWN" : value === expected ? "TRUE" : "FALSE",
    kind,
    scope: o.target,
    observationId: o.id,
    references: o.image ? [o.image] : [],
    at: o.at,
    expiresAt: o.at + 2000,
    invalidatedBy: ["revision", "focus", "target"],
    detector: "structural-equality-v1",
  };
}
export const guardPass = (p: PredicateEvidence, o: Observation) =>
  p.truth === "TRUE" &&
  p.expiresAt >= Date.now() &&
  p.scope === o.target &&
  p.observationId === o.id;
export class ObjectiveVerifier {
  verify(task: TaskContract, o: Observation) {
    return Object.entries(task.expected).map(([k, v]) => {
      if (k === "canvasChangedFrom" && task.method?.startsWith("drawing.")) {
        const actual =
          typeof o.facts.canvasImage === "string" &&
          /^[a-f0-9]{64}$/.test(String(v)) &&
          o.facts.canvasBounds === task.parameters.canvasBounds
            ? o.facts.canvasImage !== v
            : undefined;
        return fact(
          {
            ...o,
            facts: {
              ...o.facts,
              canvasChangedFrom: actual,
            } as Observation["facts"],
          },
          k,
          true,
          "completion",
        );
      }
      return fact(o, k, v, "completion");
    });
  }
}
export function semanticAssessment(
  subject: string,
  observed: string | undefined,
  o: Observation,
): PredicateEvidence {
  return {
    ...fact(o, "semantic", subject, "semantic"),
    truth:
      observed === undefined
        ? "UNKNOWN"
        : observed === subject
          ? "TRUE"
          : "FALSE",
    detector: "external-assessor-v1",
  };
}
