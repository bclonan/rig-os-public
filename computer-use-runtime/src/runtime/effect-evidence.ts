import type { Observation, PredicateEvidence } from "../contracts/index.js";

/** A FALSE value proves failure only while every required item is current. */
export function assessEffectEvidence(
  evidence: PredicateEvidence[],
  observation: Observation,
  at = Date.now(),
) {
  const unresolved = evidence.some(
    (item) =>
      item.truth === "UNKNOWN" ||
      !Number.isFinite(item.expiresAt) ||
      item.expiresAt < at ||
      item.scope !== observation.target ||
      item.observationId !== observation.id,
  );
  const knownFailure =
    !unresolved && evidence.some((item) => item.truth === "FALSE");
  return {
    unresolved,
    knownFailure,
    verified: !unresolved && !knownFailure,
  };
}
