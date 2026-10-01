import { Ajv } from "ajv";
import { seal, seedForm } from "../skills/index.js";
export const StrokePlanSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: { type: "string" },
    strokes: {
      type: "array",
      minItems: 1,
      maxItems: 60,
      items: {
        type: "array",
        minItems: 2,
        maxItems: 30,
        items: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: { type: "number", minimum: 0.05, maximum: 0.95 },
        },
      },
    },
  },
  required: ["subject", "strokes"],
};
export type StrokePlan = { subject: string; strokes: [number, number][][] };
export function drawingSkill(
  plan: StrokePlan,
  target: string,
  canvas: { x: number; y: number; width: number; height: number },
) {
  if (!new Ajv({ strict: false }).validate(StrokePlanSchema, plan))
    throw new Error("Stroke plan rejected");
  if (
    plan.strokes.some((s) =>
      s.every((p) => p[0] === s[0][0] && p[1] === s[0][1]),
    )
  )
    throw new Error("Zero-length strokes rejected");
  const segments = plan.strokes.flatMap((stroke, j) =>
    stroke.slice(1).map(([x, y], i) => ({
      id: `stroke${j}segment${i}`,
      operation: "drag",
      scope: "edit",
      args: {
        x: Math.round(canvas.x + stroke[i][0] * canvas.width),
        y: Math.round(canvas.y + stroke[i][1] * canvas.height),
        dx: Math.round(canvas.x + x * canvas.width),
        dy: Math.round(canvas.y + y * canvas.height),
      },
    })),
  );
  if (segments.length > 120) throw new Error("Stroke segment budget exceeded");
  // Paint commits brush pixels after the input segment returns. Allow its render
  // event to settle before taking the observation for the next segment.
  const steps = segments.flatMap((segment, index) => [
    segment,
    {
      id: `settle${index}`,
      operation: "wait",
      scope: "edit",
      args: {},
      waitMs: 100,
    },
  ]);
  return seal({
    ...seedForm(),
    id: "drawing." + Date.now(),
    description: "Bounded local-provider stroke plan for " + plan.subject,
    inputs: {},
    outputs: ["canvasChanged"],
    capabilities: ["drag"],
    preconditions: [],
    compatibility: [target],
    machine: {
      initial: "draw",
      states: [{ id: "draw", steps, monitor: ["focused"] }],
    },
    recovery: ["fresh_observation", "escalate"],
    budgets: { retries: 3, steps: steps.length + 3 },
  });
}
