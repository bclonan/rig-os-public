import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { structuredTask } from "../src/compiler/intent.js";
import { hash } from "../src/storage/index.js";
import { encodeContext } from "../src/learner/context.js";
import { bitmapToPng } from "../src/adapters/png.js";
import { trainingPython } from "../src/learner/python.js";
import type { Action, Observation } from "../src/contracts/index.js";

test("recorded native rows use BEFORE pixels, mask corrections and unknown success, and match production context", () => {
  const directory = mkdtempSync(join(tmpdir(), "cur-recorded-labels-"));
  const bitmap = Buffer.alloc(54 + 32 * 32 * 4);
  bitmap.write("BM");
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(32, 18);
  bitmap.writeInt32LE(-32, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(32, 28);
  for (let i = 54; i < bitmap.length; i += 4) bitmap[i + 2] = 128;
  const image = bitmapToPng(bitmap),
    imageHash = hash(image);
  const observation: Observation = {
    schemaVersion: 1,
    id: "before",
    host: "host",
    session: "session",
    target: "custom-target",
    at: 2000,
    revision: "before",
    frame: { x: 0, y: 0, width: 32, height: 32, scale: 1 },
    focused: true,
    facts: { focused: true, text: "earlier" },
    features: [],
    image: imageHash,
    backend: "test",
  };
  const task = structuredTask(
    "Replace authorized editor text",
    { host: "host", session: "session", identity: "custom-target" },
    { name: "answer" },
    "native.replace",
  );
  const action: Action = {
    schemaVersion: 1,
    id: "input",
    runId: task.id,
    requester: task.requester,
    host: "host",
    session: "session",
    target: "custom-target",
    observationId: "before",
    revision: "before",
    frame: observation.frame,
    operation: "fill",
    args: { value: "answer" },
    scope: "edit",
    generation: 1,
    deadline: 3000,
  };
  const step = {
    before: observation,
    action,
    receipt: { actionId: action.id, phase: "acknowledged" },
    after: {
      ...observation,
      id: "after",
      at: 2500,
      image: "never-read-after-image",
    },
    label: "verified",
  };
  const makeDemo = (id: string, verified: boolean, corrections: unknown[]) => ({
    session: id,
    verified,
    contract: { ...task, id },
    steps: [
      {
        ...step,
        action: { ...action, id: "input-" + id, runId: id },
        receipt: { ...step.receipt, actionId: "input-" + id },
      },
    ],
    corrections,
  });
  const bundle = {
    schemaVersion: 1,
    kind: "experience-bundle",
    privacy: { mode: "unredacted" },
    skills: [{ id: "native.replace", descriptor: [1, 0, 0, 0, 0, 0, 0, 0] }],
    artifacts: { [imageHash]: image.toString("base64") },
    demonstrations: [
      makeDemo("positive", true, []),
      makeDemo("failure", false, [{ step: 0, label: "failure" }]),
      makeDemo("unknown", false, []),
    ],
  };
  const path = join(directory, "bundle.json");
  writeFileSync(path, JSON.stringify(bundle));
  const result = spawnSync(
    trainingPython(),
    [
      "-c",
      "import sys,json;sys.path.insert(0,'learner');from recorded import load_bundle,context;from PIL import Image;rows=load_bundle(sys.argv[1],sys.argv[2]);print(json.dumps([dict(r,pixel=list(Image.open(r['image']).getpixel((0,0)))) for r in rows]))",
      path,
      directory,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  assert.deepEqual(
    rows.map((row: any) => row.teacher_choice),
    [0, -100, -100],
  );
  assert.deepEqual(
    rows.map((row: any) => row.outcome_mask[0]),
    [1, 1, 0],
  );
  assert.deepEqual(
    rows.map((row: any) => row.success_cost[0]),
    [1, 0, 0],
  );
  assert.deepEqual(
    rows.map((row: any) => row.pixel),
    [
      [128, 0, 0],
      [128, 0, 0],
      [128, 0, 0],
    ],
  );
  const expected = Array.from(
    encodeContext(task, observation, [], observation.at),
  );
  rows[0].history
    .flat()
    .forEach((value: number, i: number) =>
      assert.ok(Math.abs(value - expected[i]) < 1e-6),
    );
  assert.equal(rows[0].sourceImage, imageHash);
});
