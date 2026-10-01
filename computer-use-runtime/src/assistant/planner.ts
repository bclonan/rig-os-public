import { Ajv } from "ajv";
import type { Observation, TaskContract, Step } from "../contracts/index.js";

export const keys = [
  "Enter",
  "Tab",
  "Shift+Tab",
  "Escape",
  "Space",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
  "Control+A",
  "Control+C",
  "Control+V",
  "Control+Z",
  "Control+F",
  "Control+L",
  "Control+O",
  "Control+Tab",
  "Control+Home",
  "Control+End",
  "Control+Shift+End",
  "Control+N",
  "Control+S",
  "Control+Shift+S",
  "F12",
  "Meta+A",
  "Meta+C",
  "Meta+V",
  "Meta+Z",
  "Meta+F",
  "Meta+L",
  "Meta+O",
  "Meta+N",
  "Meta+S",
  "Meta+Shift+S",
  "Meta+ArrowLeft",
  "Meta+ArrowRight",
];
export const decisionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "summary"],
  properties: {
    kind: { type: "string", enum: ["action", "done", "question"] },
    summary: { type: "string", minLength: 1, maxLength: 4000 },
    operation: {
      type: "string",
      enum: [
        "click",
        "invoke",
        "fill",
        "type",
        "key",
        "scroll",
        "drag",
        "switch_window",
        "launch_app",
      ],
    },
    window: { type: "string", minLength: 1, maxLength: 100 },
    app: { type: "string", minLength: 1, maxLength: 100 },
    control: { type: "integer", minimum: 0 },
    text: { type: "string", maxLength: 8192 },
    key: { type: "string", enum: keys },
    x: { type: "integer", minimum: 0 },
    y: { type: "integer", minimum: 0 },
    dx: { type: "integer", minimum: 0 },
    dy: { type: "integer", minimum: 0 },
    amount: { type: "integer", minimum: -1200, maximum: 1200 },
  },
};
export type Decision = {
  kind: "action" | "done" | "question";
  summary: string;
  operation?: string;
  window?: string;
  app?: string;
  control?: number;
  text?: string;
  key?: string;
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  amount?: number;
};
const check = new Ajv({ strict: false }).compile(decisionSchema);
export function validateDecision(value: unknown): Decision {
  if (!check(value))
    throw new Error(
      "The model returned an invalid desktop action: " +
        JSON.stringify(check.errors),
    );
  const decision = value as Decision;
  if (decision.kind !== "action")
    return { kind: decision.kind, summary: decision.summary };
  const fields: Record<string, string[]> = {
    click: ["control", "x", "y"],
    invoke: ["control"],
    fill: ["control", "text"],
    type: ["control", "text"],
    key: ["key"],
    scroll: ["amount"],
    drag: ["x", "y", "dx", "dy"],
    switch_window: ["window"],
    launch_app: ["app"],
  };
  return Object.fromEntries(
    Object.entries(decision).filter(([key]) =>
      [
        "kind",
        "summary",
        "operation",
        ...(fields[decision.operation || ""] || []),
      ].includes(key),
    ),
  ) as Decision;
}
export interface DesktopPlanner {
  readonly lastCall?: unknown;
  next(
    task: TaskContract,
    observation: Observation,
    history: unknown[],
    signal: AbortSignal,
  ): Promise<Decision>;
}
// Translate model suggestions into the existing small action protocol. No arbitrary
// operation names, shell commands, files, or model-supplied permission scopes.
export function actionStep(
  decision: Decision,
  observation: Observation,
  vision: boolean,
): Step {
  decision = validateDecision(decision);
  if (decision.kind !== "action" || !decision.operation)
    throw new Error("Missing desktop action");
  const args: Step["args"] = {};
  const op = decision.operation;
  if (op === "switch_window" || op === "launch_app") {
    if (!observation.desktop)
      throw new Error("App navigation requires This computer scope");
    if (op === "switch_window") {
      const window = observation.desktop.windows.find(
        (w) => w.id === decision.window,
      );
      if (!window)
        throw new Error(
          "Choose a window from the current computer observation",
        );
      args.window = window.id;
    } else {
      const app = observation.desktop.apps.find((a) => a.id === decision.app);
      if (!app)
        throw new Error("Choose an app from the installed launcher list");
      args.app = app.id;
    }
    return { id: "desktop-navigation", operation: op, args, scope: "navigate" };
  }
  if (observation.desktop && !observation.desktop.activeWindow)
    throw new Error(
      "Switch to an open window or launch an app before using its controls",
    );
  if (
    observation.facts.supportedOperations &&
    !JSON.parse(String(observation.facts.supportedOperations)).includes(op)
  )
    throw new Error("This desktop session does not support that action");
  if (
    ["click", "invoke", "fill"].includes(op) &&
    decision.control !== undefined
  ) {
    const c = observation.controls?.find(
      (c) => c.index === decision.control && !c.offscreen,
    );
    if (!c) throw new Error("The model selected a missing control");
    if (c.actions && !c.actions.includes(op))
      throw new Error(
        `Control ${c.index} supports ${c.actions.join(", ")}, not ${op}`,
      );
    if (op === "click") {
      args.x = Math.round(
        c.bounds.x + c.bounds.width / 2 - observation.frame.x,
      );
      args.y = Math.round(
        c.bounds.y + c.bounds.height / 2 - observation.frame.y,
      );
    } else {
      if (
        c.id &&
        observation.controls?.filter((x) => x.id === c.id && !x.offscreen)
          .length === 1
      )
        args.locator = c.id;
      else if (
        c.name &&
        observation.controls?.filter(
          (x) =>
            x.name === c.name &&
            x.controlType === c.controlType &&
            !x.offscreen,
        ).length === 1
      )
        args.locator = `@name:${c.controlType}:${c.name}`;
      else
        throw new Error(
          "This control has no unique ID or name. Ask for a click instead.",
        );
      if (op === "fill") {
        if (decision.text === undefined)
          throw new Error("Missing replacement text");
        args.value = decision.text;
      }
    }
  } else if (op === "click" || op === "drag") {
    if (!vision || !observation.image)
      throw new Error("Coordinates require a model with screenshot input");
    if (observation.facts.pixelFrameCached === true)
      throw new Error(
        "Coordinates require a newly captured frame; the portal returned a cached frame",
      );
    args.x = decision.x!;
    args.y = decision.y!;
    if (op === "drag") {
      args.dx = decision.dx!;
      args.dy = decision.dy!;
    }
  } else if (op === "type") {
    if (
      !decision.text ||
      Buffer.byteLength(decision.text) > 128 ||
      /[\x00-\x08\x0b-\x1f]/.test(decision.text)
    )
      throw new Error(
        "Type requires 1 to 128 UTF-8 bytes of literal text. Use key actions for control characters.",
      );
    if (
      !observation.controls?.some(
        (c) => c.focused && [50004, 50030].includes(c.controlType),
      )
    )
      throw new Error(
        "No focused editable control. Click the editor before typing.",
      );
    if (
      decision.control !== undefined &&
      !observation.controls?.some(
        (c) =>
          c.index === decision.control &&
          c.focused &&
          [50004, 50030].includes(c.controlType),
      )
    )
      throw new Error("The proposed text target is not the focused editor");
    args.text = decision.text;
  } else if (op === "key") {
    if (!decision.key || !keys.includes(decision.key))
      throw new Error("Unsupported key");
    if (
      observation.facts.supportedKeys &&
      !JSON.parse(String(observation.facts.supportedKeys)).includes(
        decision.key,
      )
    )
      throw new Error("This shortcut is not supported by this OS session");
    if (
      decision.key.startsWith("Meta+") &&
      observation.facts.desktopPlatform !== "macOS"
    )
      throw new Error("Command shortcuts require macOS");
    args.key = decision.key;
  } else if (op === "scroll") {
    if (!decision.amount) throw new Error("Missing scroll amount");
    args.amount = decision.amount;
  } else throw new Error("Missing action target");
  if (op === "click" || op === "drag") {
    for (const [key, max] of [
      ["x", observation.frame.width],
      ["y", observation.frame.height],
      ...(op === "drag"
        ? [
            ["dx", observation.frame.width],
            ["dy", observation.frame.height],
          ]
        : []),
    ] as [string, number][]) {
      if (
        !Number.isInteger(args[key]) ||
        Number(args[key]) < 0 ||
        Number(args[key]) >= max
      )
        throw new Error("Point outside the selected app");
    }
  }
  return {
    id: "desktop-action",
    operation: op,
    args,
    scope:
      op === "key" &&
      [
        "Control+S",
        "Control+Shift+S",
        "Meta+S",
        "Meta+Shift+S",
        "F12",
      ].includes(String(args.key))
        ? "save"
        : "edit",
  };
}
