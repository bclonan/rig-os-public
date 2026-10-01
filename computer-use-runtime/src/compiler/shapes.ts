import { Ajv } from "ajv";
import type { ModelProvider } from "../contracts/ports.js";
import type { StrokePlan } from "./drawing.js";

export type ShapePlan = {
  subject: string;
  parts: {
    name: string;
    kind: "ellipse" | "polyline";
    x: number;
    y: number;
    rx: number;
    ry: number;
    points: [number, number][];
  }[];
};
const coordinate = { type: "number", minimum: 0.05, maximum: 0.95 };
export const ShapePlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "parts"],
  properties: {
    subject: { type: "string", minLength: 1, maxLength: 100 },
    parts: {
      type: "array",
      minItems: 1,
      maxItems: 15,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "kind", "x", "y", "rx", "ry", "points"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 80 },
          kind: { enum: ["ellipse", "polyline"] },
          x: { type: "number", minimum: 0, maximum: 0.95 },
          y: { type: "number", minimum: 0, maximum: 0.95 },
          rx: { type: "number", minimum: 0, maximum: 0.4 },
          ry: { type: "number", minimum: 0, maximum: 0.4 },
          points: {
            type: "array",
            maxItems: 12,
            items: {
              type: "array",
              minItems: 2,
              maxItems: 2,
              items: coordinate,
            },
          },
        },
      },
    },
  },
};

export function shapeStrokes(value: unknown): StrokePlan {
  const validator = new Ajv({ strict: false, allErrors: true });
  if (!validator.validate(ShapePlanSchema, value))
    throw new Error(
      "Creative shape schema rejected: " + JSON.stringify(validator.errors),
    );
  const plan = value as ShapePlan;
  const ellipseCounts = plan.parts.map((part) =>
    part.kind === "ellipse" ? 8 : 0,
  );
  let used = plan.parts.reduce(
    (count, part, i) =>
      count +
      (part.kind === "ellipse"
        ? ellipseCounts[i]
        : Math.max(0, part.points.length - 1)),
    0,
  );
  if (used > 120) throw new Error("Creative segment budget exceeded");
  // Spend the remaining fixed budget on the largest curves first. Small eyes
  // need fewer segments than a body outline. Geometry remains model supplied.
  while (used < 120) {
    const index = plan.parts.reduce((best, part, i) => {
      if (
        part.kind !== "ellipse" ||
        ellipseCounts[i] >= 16 ||
        Math.max(part.rx, part.ry) <= 0.025
      )
        return best;
      const weight = Math.hypot(part.rx, part.ry) / ellipseCounts[i];
      return best < 0 ||
        weight >
          Math.hypot(plan.parts[best].rx, plan.parts[best].ry) /
            ellipseCounts[best]
        ? i
        : best;
    }, -1);
    if (index < 0) break;
    ellipseCounts[index]++;
    used++;
  }
  const strokes: [number, number][][] = plan.parts.map((part, index) => {
    if (part.kind === "polyline") {
      if (part.points.length < 2 || part.rx !== 0 || part.ry !== 0)
        throw new Error(
          "Polyline needs at least two points and zero ellipse radii",
        );
      return part.points;
    }
    if (part.rx <= 0 || part.ry <= 0 || part.points.length)
      throw new Error("Ellipse needs positive radii and no polyline points");
    const count = ellipseCounts[index];
    return Array.from({ length: count + 1 }, (_, i): [number, number] => [
      part.x + part.rx * Math.cos((i * 2 * Math.PI) / count),
      part.y + part.ry * Math.sin((i * 2 * Math.PI) / count),
    ]);
  });
  if (
    strokes.some((stroke) =>
      stroke.some((point) =>
        point.some((n) => n < 0.05 - 1e-9 || n > 0.95 + 1e-9),
      ),
    )
  )
    throw new Error("Shape extends outside the normalized drawing area");
  if (strokes.reduce((count, stroke) => count + stroke.length - 1, 0) > 120)
    throw new Error("Creative segment budget exceeded");
  return {
    subject: plan.subject,
    strokes: strokes.map((stroke) =>
      stroke.map(
        (point) =>
          point.map((n) => Math.max(0.05, Math.min(0.95, n))) as [
            number,
            number,
          ],
      ),
    ),
  };
}

export async function planShapes(
  goal: string,
  provider: ModelProvider,
  signal?: AbortSignal,
) {
  const attempts: { plan: unknown; error?: string }[] = [];
  let feedback = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const plan = await provider.generate(
      [
        `Draw the user's requested subject as a recognizable black line illustration. User request: ${JSON.stringify(goal)}.`,
        "Return geometric parts in normalized coordinates on a blank canvas. Ellipses have center x,y, positive radii rx,ry and points=[]; polylines have at least two points, unused x=0,y=0, and rx=0,ry=0. Every part must have all fields in the schema.",
        "Use connected, clearly arranged outlines. Build the body, head and muzzle with ellipses when suitable. Connect feet or limbs to the body, ears to the head, and tail to the body. Include a small eye using an ellipse. Do not draw text.",
        "For an animal without a requested perspective, choose a clear side profile. Use a horizontally elongated body, a smaller head overlapping its front upper corner, and a distinct projecting muzzle. Put legs below the body. Attach the tail at the opposite end. Choose ears typical of the requested animal. Avoid a front-facing head above the center of the body, which can look like a person or a different animal.",
        "Keep all visible points within coordinates 0.05..0.95. Use at most 15 parts and 120 total line segments. The compiler samples each ellipse with 8 to 16 segments within that limit. Prefer continuous polylines for legs and tails, and connect their endpoints to the body outline. Keep the composition centered and large enough to inspect. Never save, import or upload an image.",
        feedback,
      ].join("\n"),
      ShapePlanSchema,
      signal,
    );
    try {
      const strokes = shapeStrokes(plan);
      attempts.push({ plan });
      return { plan: plan as ShapePlan, strokes, attempts };
    } catch (error) {
      const detail = String(error);
      attempts.push({ plan, error: detail });
      feedback = `Repair this invalid geometry without changing the user request. Error ${detail}. Prior shape plan ${JSON.stringify(plan)}`;
    }
  }
  throw new Error(
    "Creative geometry failed its bounded construction checks: " +
      JSON.stringify(attempts),
  );
}
