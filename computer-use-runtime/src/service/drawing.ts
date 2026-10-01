import { randomUUID } from "node:crypto";
import type { ModelProvider } from "../contracts/ports.js";
import type { Runtime } from "../runtime/index.js";
import { DesktopRouter } from "../adapters/desktop.js";
import { structuredTask } from "../compiler/intent.js";
import { planShapes } from "../compiler/shapes.js";
import { drawingSkill } from "../compiler/drawing.js";
import { seal, checkSkill } from "../skills/index.js";
import { canonical, hash } from "../storage/index.js";
import {
  providerSettings,
  providerParameters,
  type ProviderSettings,
} from "../providers/settings.js";

export async function createDrawingPlan(
  runtime: Runtime,
  value: unknown,
  requestKey: string,
  provider: (model: string, settings: ProviderSettings) => ModelProvider,
  signal: AbortSignal,
) {
  const body = value as {
    goal: string;
    model: string;
    handle: number;
    pid: number;
  };
  if (
    !body ||
    typeof body.goal !== "string" ||
    !body.goal.trim() ||
    body.goal.length > 4000 ||
    !Number.isSafeInteger(body.handle) ||
    !Number.isSafeInteger(body.pid)
  )
    throw new Error(
      "Choose a Paint window, model provider and drawing request",
    );
  const settings = providerSettings(body);
  if (!(runtime.adapter instanceof DesktopRouter))
    throw new Error("Desktop adapter is not configured");
  const router = runtime.adapter;
  const key = hash("drawing-plan:" + requestKey);
  const digest = hash(canonical(body));
  let request = runtime.store.get<{ id: string; digest: string }>(
    "drawing-plan-requests",
    key,
  );
  if (request && request.digest !== digest)
    throw new Error("Drawing request key reused with different input");
  if (!request) {
    request = { id: randomUUID(), digest };
    runtime.store.put("drawing-plan-requests", key, request);
  }
  const prior = runtime.store.get<any>("drawing-plans", request.id);
  if (prior?.ready) return prior;
  const id = request.id;
  try {
    return await runtime.configureEnvironment(async () => {
      const completed = runtime.store.get<any>("drawing-plans", id);
      if (completed?.ready) return completed;
      const desktop = await router.windows();
      const window = desktop.windows.find(
        (entry) => entry.handle === body.handle && entry.pid === body.pid,
      );
      if (!window || !/[/\\]mspaint\.exe$/i.test(window.executable))
        throw new Error(
          "Select an available Paint window. Existing documents are not opened or replaced by this request.",
        );
      runtime.store.put("drawing-plans", id, {
        id,
        goal: body.goal.trim(),
        model: settings.model,
        phase: "constructing",
        ready: false,
      });
      const selectedProvider = provider(settings.model, settings);
      const construction = await planShapes(
        body.goal.trim(),
        selectedProvider,
        signal,
      );
      const task = structuredTask(
        body.goal.trim(),
        {
          host: desktop.host!,
          session: desktop.session!,
          identity: String(window.handle),
        },
        {
          windowPid: window.pid,
          desktopScope: "window",
          ...providerParameters(settings),
        },
        "desktop.assistant",
      );
      task.id = id;
      await router.prepare(task);
      await router.acquire(id);
      let prepared: any;
      try {
        await router.focus();
        const observation = await runtime.observe(task, signal);
        const canvas = observation.controls?.filter(
          (entry) => entry.id === "image" && !entry.offscreen,
        );
        if (
          canvas?.length !== 1 ||
          typeof observation.facts.canvasImage !== "string" ||
          typeof observation.facts.canvasBounds !== "string"
        )
          throw new Error("Paint must expose one verified visible canvas");
        const area = {
          x: canvas[0].bounds.x - observation.frame.x,
          y: canvas[0].bounds.y - observation.frame.y,
          width: Math.min(canvas[0].bounds.width, 1000),
          height: Math.min(canvas[0].bounds.height, 700),
        };
        const pencil = observation.controls?.filter(
          (entry) => entry.id === "PencilTool" && !entry.offscreen,
        );
        const black = observation.controls?.filter(
          (entry) =>
            entry.name === "Black" &&
            entry.controlType === 50007 &&
            !entry.offscreen,
        );
        if (pencil?.length !== 1 || black?.length !== 1)
          throw new Error(
            "Paint must expose the Pencil tool and black color before a drawing can be planned",
          );
        const compiled = drawingSkill(
          construction.strokes,
          observation.target,
          area,
        );
        const setup: (typeof compiled.machine.states)[number]["steps"] = [
          {
            id: "selectPencil",
            operation: "click",
            scope: "edit",
            args: { locator: "PencilTool" },
          },
          {
            id: "settlePencil",
            operation: "wait",
            scope: "edit",
            args: {},
            waitMs: 100,
          },
          {
            id: "selectBlack",
            operation: "click",
            scope: "edit",
            args: { locator: "@name:50007:Black" },
          },
          {
            id: "settleBlack",
            operation: "wait",
            scope: "edit",
            args: {},
            waitMs: 100,
          },
        ];
        const skill = seal({
          ...compiled,
          capabilities: ["click", "drag"],
          machine: {
            ...compiled.machine,
            states: compiled.machine.states.map((state) => ({
              ...state,
              steps: [...setup, ...state.steps],
            })),
          },
          budgets: {
            ...compiled.budgets,
            steps: compiled.budgets.steps + setup.length,
          },
          id: "drawing." + id,
          description:
            "One-use generated drawing through the trusted bounded drag compiler. This is not a learned or published reusable skill.",
        });
        task.method = skill.id;
        task.expected = {
          canvasChangedFrom: observation.facts.canvasImage,
          canvasBounds: observation.facts.canvasBounds,
        };
        task.parameters.drawingFrame = canonical(observation.frame);
        task.parameters.canvasBounds = observation.facts.canvasBounds;
        task.effects = ["edit"];
        task.requirements = [
          { name: "subject", value: body.goal.trim(), origin: "user_explicit" },
          {
            name: "semantic_acceptance",
            value:
              "Independent canvas assessment and user review are separate from verified stroke execution",
            origin: "system_policy",
          },
          {
            name: "perspective",
            value:
              "Animal side profile unless another perspective is requested",
            origin: "chosen_default",
          },
        ];
        task.budgets = { steps: skill.budgets.steps, deadlineMs: 300000 };
        const plan = {
          id,
          ready: true,
          phase: "awaiting_approval",
          construction,
          providerResults:
            "lastCall" in selectedProvider
              ? selectedProvider.lastCall
              : undefined,
          task,
          skill: checkSkill(skill),
          contractHash: hash(canonical(task)),
          initialObservation: observation,
          drawingArea: area,
          inputHash: digest,
          permittedEffects: ["edit"],
          setupActions: ["Select Pencil", "Select black color"],
          segmentCount: construction.strokes.strokes.reduce(
            (count, stroke) => count + stroke.length - 1,
            0,
          ),
          oneUseGeneratedCoordinates: true,
          reusableSkillQualification: false,
        };
        prepared = plan;
      } finally {
        await router.release(id);
      }
      runtime.store.put("drawing-plans", id, prepared);
      return prepared;
    });
  } catch (error) {
    runtime.store.put("drawing-plan-failures", id + "." + Date.now(), {
      id,
      at: Date.now(),
      error: String(error),
    });
    throw error;
  }
}
