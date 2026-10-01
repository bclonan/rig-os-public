import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomInt } from "node:crypto";
import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { NativeClient, WindowsAdapter } from "../src/adapters/native.js";
import { OllamaProvider } from "../src/providers/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { drawingSkill } from "../src/compiler/drawing.js";
import { seal } from "../src/skills/index.js";
import { fact } from "../src/predicates/index.js";
import { Ajv } from "ajv";
const probe = new NativeClient();
const w = (await probe.call("windows")).find(
  (w: any) => w.title === "Untitled - Paint",
);
if (!w) throw new Error("Open the disposable Paint window");
const elements = await probe.call("accessibility", { handle: w.handle });
await probe.close();
const canvas = elements.find((e: any) => e.id === "image");
const path = resolve(
  "evidence/paint-shape-" + randomInt(100000, 999999) + ".png",
);
if (existsSync(path)) throw new Error("Refusing overwrite");
const goal = `In Paint draw a closed square near the top left of the visible canvas, then save a new PNG file at ${path}.`;
const schema = {
  type: "object",
  additionalProperties: false,
  properties: { shape: { const: "square" }, savePath: { const: path } },
  required: ["shape", "savePath"],
};
const plan: any = await new OllamaProvider("qwen3:1.7b").generate(
  "Extract requested shape and exact save path. The path is an immutable explicit parameter: " +
    JSON.stringify(path) +
    ". " +
    goal,
  schema,
);
writeFileSync(
  "evidence/paint-save-contract.json",
  JSON.stringify({ goal, path, plan }, null, 2),
);
if (
  !new Ajv({ strict: false }).validate(schema, plan) ||
  plan.savePath !== path
)
  throw new Error("Shape/save contract rejected");
const store = new Store(".data/paint-save-" + Date.now()),
  adapter = await new WindowsAdapter(store, false).start(w.handle);
const runtime = new Runtime(store, adapter, {
  verify(_t, o) {
    return [
      fact(
        { ...o, facts: { ...o.facts, newArtifactExists: existsSync(path) } },
        "newArtifactExists",
        true,
        "completion",
      ),
    ];
  },
});
const result: any = {
  goal,
  path,
  plan,
  evidenceLevel: "native desktop",
  status: "NOT RUN",
  scope: ["edit", "save"],
};
try {
  const o = await adapter.observe();
  const crop = {
    x: canvas.bounds.x - o.frame.x,
    y: canvas.bounds.y - o.frame.y,
    width: Math.min(canvas.bounds.width, 400),
    height: Math.min(canvas.bounds.height, 400),
  };
  const draw = drawingSkill(
    {
      subject: "square",
      strokes: [
        [
          [0.15, 0.15],
          [0.45, 0.15],
          [0.45, 0.45],
          [0.15, 0.45],
          [0.15, 0.15],
        ],
      ],
    },
    adapter.identity,
    crop,
  );
  const steps = draw.machine.states[0].steps;
  const skill = seal({
    ...draw,
    id: "paint.save-square",
    effects: ["edit", "save"],
    capabilities: ["drag", "key", "type", "observe"],
    budgets: { steps: 12, retries: 0 },
    machine: {
      initial: "draw",
      states: [
        {
          id: "draw",
          steps: [
            ...steps,
            {
              id: "save-as",
              operation: "key",
              scope: "save",
              args: { key: "Control+Shift+S" },
            },
            {
              id: "dialog-wait",
              operation: "wait",
              scope: "save",
              waitMs: 800,
              args: {},
            },
            {
              id: "select-filename",
              operation: "key",
              scope: "save",
              guard: "ownedDialog",
              args: { key: "Control+A" },
            },
            {
              id: "filename",
              operation: "type",
              scope: "save",
              guard: "ownedDialog",
              args: { text: path },
            },
            {
              id: "save",
              operation: "key",
              scope: "save",
              guard: "ownedDialog",
              args: { key: "Enter" },
            },
            {
              id: "save-wait",
              operation: "wait",
              scope: "save",
              waitMs: 800,
              args: {},
            },
          ],
          monitor: ["focused"],
        },
      ],
    },
  });
  runtime.registry.put(skill);
  const task = structuredTask(
    goal,
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    {},
    skill.id,
  );
  task.effects = ["edit", "save"];
  task.budgets = { steps: 12, deadlineMs: 45000 };
  task.expected = { newArtifactExists: true };
  runtime.submit(task, task.id);
  await runtime.execute(task.id);
  result.run = store.run(task.id);
  result.events = store.events(0, task.id);
  result.status =
    result.run.status === "succeeded" ? "SAVED_PENDING_IMAGE_CHECK" : "FAIL";
  const after = await adapter.observe();
  writeFileSync("evidence/paint-save.bmp", store.artifactRead(after.image!));
} catch (e) {
  result.status = "FAIL";
  result.reason = String(e);
} finally {
  await runtime.close();
  writeFileSync("evidence/paint-save.json", JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      status: result.status,
      path,
      reason: result.reason,
      error: result.run?.error,
    }),
  );
}
