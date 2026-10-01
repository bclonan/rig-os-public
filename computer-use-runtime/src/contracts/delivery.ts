import { validate, type Action, type Receipt } from "./index.js";

/** Delivery uncertainty is a control state, never a message-text convention. */
export class UncertainDeliveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UncertainDeliveryError";
  }
}

export type ClassifiedDelivery = {
  kind: "acknowledged" | "not_dispatched";
  receipt: Receipt;
};

/** Only an exact bound dispatched:false rejection proves safe non-delivery. */
export function classifyDelivery(
  action: Action,
  value: unknown,
): ClassifiedDelivery {
  let receipt: Receipt;
  try {
    receipt = validate<Receipt>("Receipt", value);
  } catch (error) {
    throw new UncertainDeliveryError("Uncertain delivery: invalid receipt", {
      cause: error,
    });
  }
  if (receipt.actionId !== action.id || receipt.runId !== action.runId)
    throw new UncertainDeliveryError(
      "Uncertain delivery: receipt does not bind this action and run",
    );
  if (
    !Number.isFinite(receipt.at) ||
    Object.values(receipt.timings).some((value) => !Number.isFinite(value))
  )
    throw new UncertainDeliveryError(
      "Uncertain delivery: receipt has nonfinite timing values",
    );
  if (receipt.phase === "rejected" && receipt.dispatched === false)
    return { kind: "not_dispatched", receipt };
  if (
    ["acknowledged", "effect_verified"].includes(receipt.phase) &&
    receipt.dispatched !== false
  )
    return { kind: "acknowledged", receipt };
  throw new UncertainDeliveryError(
    "Uncertain delivery: receipt does not prove delivery or non-delivery",
  );
}

/** A journal error cannot turn possible delivery into a recoverable failure. */
export function uncertainDelivery(
  message: string,
  error: unknown,
  record: () => void,
): UncertainDeliveryError {
  let cause = error;
  try {
    record();
  } catch (journalError) {
    cause = new AggregateError(
      [error, journalError],
      "Delivery uncertainty journal failed",
    );
  }
  return new UncertainDeliveryError(message, { cause });
}
