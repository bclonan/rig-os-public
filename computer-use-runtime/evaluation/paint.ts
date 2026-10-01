import { writeFileSync, readFileSync } from "node:fs";
import { NativeClient, WindowsAdapter } from "../src/adapters/native.js";
import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { OllamaProvider } from "../src/providers/index.js";
import {
  StrokePlanSchema,
  drawingSkill,
  type StrokePlan,
} from "../src/compiler/drawing.js";
import { structuredTask } from "../src/compiler/intent.js";
import { Ajv } from "ajv";
const goal = "Open Paint and draw a dog.";
const creativeModel = process.env.CUR_CREATIVE || "qwen3:1.7b";
if (process.argv.includes("--plan")) {
  let prompt =
    "Produce a simple recognizable side-view dog as a bounded black line drawing. " +
    goal +
    " Every x and y MUST be a decimal between 0.05 and 0.95 inclusive. Origin top left, y downward. Include the body, four legs, head, ears, muzzle and tail. Each stroke is a polyline. At most 15 strokes and 50 total line segments. Never save or import an image. JSON only.";
  let plan: any;
  const validator = new Ajv({ strict: false }).compile(StrokePlanSchema);
  const attempts: any[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    plan = await new OllamaProvider(creativeModel).generate(
      prompt,
      StrokePlanSchema,
    );
    attempts.push({ plan, valid: validator(plan), errors: validator.errors });
    if (validator(plan)) break;
    prompt +=
      " Your prior coordinates failed schema validation. Use decimal coordinates ONLY within 0.05 to 0.95. Prior response: " +
      JSON.stringify(plan);
  }
  writeFileSync(
    "evidence/paint-plan-attempts.json",
    JSON.stringify(attempts, null, 2),
  );
  if (!validator(plan))
    throw new Error(
      "Provider did not produce safe normalized stroke coordinates",
    );
  writeFileSync(
    "evidence/paint-plan.json",
    JSON.stringify(
      { goal, provider: creativeModel, at: new Date().toISOString(), plan },
      null,
      2,
    ),
  );
  console.log("Local model stroke plan saved for bounded execution.");
} else {
  const probe = new NativeClient();
  const matches = (await probe.call("windows")).filter(
    (w: any) => w.title === "Untitled - Paint",
  );
  if (matches.length !== 1)
    throw new Error("Exactly one empty Untitled Paint window is required");
  const w = matches[0],
    elements = await probe.call("accessibility", { handle: w.handle });
  await probe.close();
  const canvas = elements.find((e: any) => e.id === "image" && !e.offscreen);
  if (!canvas) throw new Error("No verified Paint canvas");
  const store = new Store(".data/paint-" + Date.now()),
    adapter = await new WindowsAdapter(store, false).start(w.handle),
    runtime = new Runtime(store, adapter);
  const before = await adapter.observe();
  const record: any = {
    goal,
    evidenceLevel: "native desktop",
    status: "NOT RUN",
    canvas: canvas.bounds,
    permission: ["edit"],
    savingAuthorized: false,
    semantic: {
      status: "UNVERIFIED",
      reason:
        "Stroke generation and changed pixels cannot establish a recognizable dog",
    },
  };
  try {
    const plan = JSON.parse(readFileSync("evidence/paint-plan.json", "utf8"))
      .plan as StrokePlan;
    const skill = drawingSkill(plan, adapter.identity, {
      x: canvas.bounds.x - before.frame.x,
      y: canvas.bounds.y - before.frame.y,
      width: canvas.bounds.width,
      height: canvas.bounds.height,
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
    task.expected = { dogRecognizable: true };
    task.budgets = { steps: 120, deadlineMs: 120000 };
    runtime.submit(task, task.id);
    await runtime.execute(task.id);
    const after = await adapter.observe();
    record.run = store.run(task.id);
    record.events = store.events(0, task.id);
    record.status =
      record.run.status === "blocked" && record.run.cursor > 0
        ? "PARTIAL"
        : "FAIL";
    record.completedSegments = record.run.cursor;
    record.totalSegments = skill.machine.states[0].steps.length;
    record.pixelHashChanged = before.image !== after.image;
    writeFileSync(
      "evidence/paint-before.bmp",
      store.artifactRead(before.image!),
    );
    writeFileSync("evidence/paint-after.bmp", store.artifactRead(after.image!));
  } catch (e) {
    record.status = "FAIL";
    record.reason = String(e);
  } finally {
    await runtime.close();
    writeFileSync("evidence/paint.json", JSON.stringify(record, null, 2));
    console.log(
      JSON.stringify({
        status: record.status,
        segments: record.completedSegments,
        total: record.totalSegments,
        reason: record.reason,
        runError: record.run?.error,
        semantic: record.semantic,
      }),
    );
  }
}
