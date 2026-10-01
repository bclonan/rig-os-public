import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NativeClient, WindowsAdapter } from "../src/adapters/native.js";
import { launchDesktopApp } from "../src/adapters/desktop-apps.js";
import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { drawingSkill } from "../src/compiler/drawing.js";
import { seal } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { fact } from "../src/predicates/index.js";
import type { SkillCapsule } from "../src/contracts/index.js";
import { spawnSync } from "node:child_process";
import { trainingPython } from "../src/learner/python.js";

if (process.platform !== "win32")
  throw new Error("This check requires Windows Paint");
const probe = new NativeClient();
const before = new Set((await probe.call("windows")).map((w: any) => w.handle));
await launchDesktopApp("paint");
let window: any;
for (let attempt = 0; attempt < 50 && !window; attempt++) {
  await delay(200);
  window = (await probe.call("windows")).find(
    (w: any) => !before.has(w.handle) && w.title === "Untitled - Paint",
  );
}
await probe.close();
assert.ok(
  window,
  "Paint did not create a new disposable window; no existing document was changed",
);
const store = new Store(mkdtempSync(join(tmpdir(), "cur-review-paint-")));
const adapter = await new WindowsAdapter(store, false).start(window.handle);
const path = resolve("evidence/review-square-" + Date.now() + ".png");
assert.equal(existsSync(path), false);
const runtime = new Runtime(store, adapter, {
  verify(task, observation) {
    if (task.expected.pngSaved) {
      const valid =
        existsSync(path) &&
        readFileSync(path)
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return [
        fact(
          { ...observation, facts: { ...observation.facts, pngSaved: valid } },
          "pngSaved",
          true,
          "completion",
        ),
      ];
    }
    if (task.expected.filename) {
      const filenames =
        observation.controls?.filter(
          (c) =>
            c.controlType === 50004 && c.name === "File name:" && !c.offscreen,
        ) || [];
      const formats =
        observation.controls?.filter(
          (c) => c.id === "FileTypeControlHost" && !c.offscreen,
        ) || [];
      observation = {
        ...observation,
        facts: {
          ...observation.facts,
          filename: filenames.length === 1 ? filenames[0].value : "",
          format: formats.length === 1 ? formats[0].value : "",
        },
      };
    }
    return Object.entries(task.expected).map(([name, value]) =>
      fact(observation, name, value, "completion"),
    );
  },
});
const report: any = {
  at: new Date().toISOString(),
  status: "FAIL",
  level: "new native Paint document, Rust/UIA, explicit unique PNG save",
  path,
  window,
  runs: [],
};
async function run(
  skill: SkillCapsule,
  expected: Record<string, string | number | boolean>,
) {
  runtime.registry.put(skill);
  const task = structuredTask(
    "Draw a square and save a new PNG in the private test artifact directory",
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    {},
    skill.id,
  );
  task.effects = ["edit", "save"];
  task.expected = expected;
  task.budgets = { steps: 30, deadlineMs: 45000 };
  runtime.submit(task, task.id);
  await runtime.execute(task.id);
  const result = store.run(task.id);
  report.runs.push({
    status: result.status,
    error: result.error,
    steps: result.cursor,
  });
  assert.equal(
    result.status,
    "succeeded",
    result.error || "Native result was not verified",
  );
}
try {
  await adapter.focus();
  const observation = await adapter.observe();
  const canvas = observation.controls?.find(
    (c) => c.id === "image" && !c.offscreen,
  );
  assert.ok(canvas, "Paint canvas is not exposed by accessibility");
  report.canvas = canvas.bounds;
  writeFileSync(
    "evidence/review-paint-before.png",
    store.artifactRead(observation.image!),
  );
  const square = drawingSkill(
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
    {
      x: canvas.bounds.x - observation.frame.x,
      y: canvas.bounds.y - observation.frame.y,
      width: 400,
      height: 400,
    },
  );
  const drawAndOpen = seal({
    ...square,
    id: "review.paint-square",
    effects: ["edit", "save"],
    capabilities: ["drag", "key"],
    machine: {
      initial: "draw",
      states: [
        {
          id: "draw",
          monitor: ["focused"],
          steps: square.machine.states[0].steps,
          next: "dialog",
        },
        // Opening a modal transfers foreground ownership. Wait for the owned dialog before further input.
        {
          id: "dialog",
          monitor: [],
          steps: [
            {
              id: "save-as",
              operation: "key",
              args: { key: "F12" },
              scope: "save",
            },
            {
              id: "wait-dialog",
              operation: "wait",
              args: {},
              scope: "save",
              waitFor: "ownedDialog",
              waitMs: 5000,
            },
          ],
        },
      ],
    },
  });
  await run(drawAndOpen, { ownedDialog: true });
  const dialog = await adapter.observe();
  writeFileSync(
    "evidence/review-paint-dialog-controls.json",
    JSON.stringify(dialog.controls, null, 2),
  );
  writeFileSync(
    "evidence/review-paint-dialog.png",
    store.artifactRead(dialog.image!),
  );
  if (process.argv.includes("--inspect")) {
    report.status = "INSPECTED";
  } else {
    const save = seal({
      ...square,
      id: "review.paint-png",
      effects: ["save"],
      capabilities: ["type", "select", "key", "click"],
      preconditions: ["ownedDialog"],
      machine: {
        initial: "save",
        states: [
          {
            id: "save",
            monitor: ["focused"],
            steps: [
              {
                id: "format",
                operation: "select",
                scope: "save",
                args: { locator: "FileTypeControlHost", value: "PNG (*.png)" },
              },
              {
                id: "filename-focus",
                operation: "click",
                scope: "save",
                args: { locator: "@name:50004:File name:" },
              },
              {
                id: "filename-select",
                operation: "key",
                scope: "save",
                args: { key: "Control+A" },
              },
              {
                id: "filename",
                operation: "type",
                scope: "save",
                args: { text: path },
              },
              {
                id: "commit-filename",
                operation: "key",
                scope: "save",
                args: { key: "Tab" },
              },
            ],
          },
        ],
      },
    });
    await run(save, { filename: path, format: "PNG (*.png)" });
    writeFileSync(
      "evidence/review-paint-filename.png",
      store.artifactRead((await adapter.observe()).image!),
    );
    // Only click Save after independently reading the exact filename and format back from the dialog.
    const commit = seal({
      ...save,
      id: "review.paint-save",
      machine: {
        initial: "save",
        states: [
          {
            id: "save",
            monitor: [],
            steps: [
              {
                id: "save",
                operation: "click",
                scope: "save",
                args: { locator: "@name:50000:Save" },
              },
              {
                id: "settle",
                operation: "wait",
                scope: "save",
                args: {},
                waitMs: 800,
              },
            ],
          },
        ],
      },
    });
    await run(commit, { pngSaved: true });
    report.status = "PNG_SAVED_SHAPE_CHECK_PENDING";
  }
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await runtime.close();
  writeFileSync("evidence/review-paint.json", JSON.stringify(report, null, 2));
  if (report.status === "PNG_SAVED_SHAPE_CHECK_PENDING") {
    const checked = spawnSync(
      trainingPython(),
      [
        "evaluation/check-paint-image.py",
        "evidence/review-paint.json",
        "evidence/review-paint-image-check.json",
      ],
      { windowsHide: true, encoding: "utf8", timeout: 15000 },
    );
    report.status = checked.status === 0 ? "PASS" : "FAIL";
    report.shapeCheck = "evidence/review-paint-image-check.json";
    if (checked.status !== 0) {
      report.error = checked.stderr || checked.stdout;
      process.exitCode = 1;
    }
    writeFileSync(
      "evidence/review-paint.json",
      JSON.stringify(report, null, 2),
    );
  }
  console.log(JSON.stringify(report));
}
