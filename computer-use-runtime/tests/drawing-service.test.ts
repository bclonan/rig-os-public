import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, canonical } from "../src/storage/index.js";
import { DesktopRouter } from "../src/adapters/desktop.js";
import type { WindowsAdapter } from "../src/adapters/native.js";
import type { Action, Observation } from "../src/contracts/index.js";
import { Runtime } from "../src/runtime/index.js";
import { service } from "../src/service/index.js";
import { Policy } from "../src/runtime/policy.js";

test("frozen drawing approval uses one bounded edit program, preserves semantic review and cannot expand authority", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-drawing-service-")));
  const router = new DesktopRouter(store);
  await router.browser.start();
  const frame = { x: 10, y: 20, width: 100, height: 100, scale: 1 };
  const bounds = { x: 10, y: 20, width: 100, height: 100 };
  let image = store.artifact("controlled-before"),
    calls = 0,
    dispatched = 0;
  const native = {
    host: "host",
    session: "session",
    identity: "1",
    capabilities: ["click", "drag"],
    platform: "Windows",
    notes: "scripted unit double",
    client: {
      async call() {
        return [
          {
            handle: 1,
            pid: 2,
            title: "Owned empty fixture",
            executable: "C:\\fixture\\mspaint.exe",
          },
        ];
      },
    },
    async setTarget() {},
    async focus() {},
    async acquire() {
      return 1;
    },
    async release() {},
    async close() {},
    async observe(): Promise<Observation> {
      return {
        schemaVersion: 1,
        id: randomUUID(),
        host: "host",
        session: "session",
        target: "1",
        at: Date.now(),
        revision: image,
        frame,
        focused: true,
        image,
        features: [],
        backend: "scripted-unit-double",
        facts: {
          focused: true,
          canvasImage: image,
          canvasBounds: JSON.stringify(bounds),
        },
        controls: [
          {
            index: 1,
            id: "PencilTool",
            name: "Pencil",
            value: "",
            focused: false,
            offscreen: false,
            controlType: 50000,
            bounds,
          },
          {
            index: 2,
            id: "black",
            name: "Black",
            value: "",
            focused: false,
            offscreen: false,
            controlType: 50007,
            bounds,
          },
          {
            index: 0,
            id: "image",
            name: "canvas",
            value: "",
            focused: true,
            offscreen: false,
            controlType: 50032,
            bounds,
          },
        ],
      };
    },
    async execute(action: Action) {
      dispatched++;
      image = store.artifact("controlled-after");
      return {
        schemaVersion: 1,
        actionId: action.id,
        runId: action.runId,
        at: Date.now(),
        backend: "scripted-unit-double",
        phase: "acknowledged",
        detail: "unit fixture",
        timings: {},
      };
    },
  };
  router.native = native as unknown as WindowsAdapter;
  const runtime = new Runtime(store, router);
  const app = await service(runtime, {
    drawingProvider: () => ({
      capabilities: {
        schemaVersion: 1,
        id: "scripted-unit-double",
        modalities: ["text"],
        structuredOutput: true,
        tools: false,
        cancellation: true,
        local: true,
        maxTokens: 1000,
        available: true,
      },
      async generate() {
        calls++;
        return {
          subject: "square",
          parts: [
            {
              name: "outline",
              kind: "polyline",
              x: 0.5,
              y: 0.5,
              rx: 0,
              ry: 0,
              points: [
                [0.2, 0.2],
                [0.8, 0.2],
                [0.8, 0.8],
                [0.2, 0.8],
                [0.2, 0.2],
              ],
            },
          ],
        };
      },
    }),
  });
  const headers = {
    host: "127.0.0.1",
    authorization: "Bearer " + store.token(),
    "idempotency-key": "drawing-request",
    "x-correlation-id": "correlation",
  };
  const body = {
    goal: "Draw a square without saving",
    model: "scripted",
    handle: 1,
    pid: 2,
  };
  try {
    const created = await app.inject({
      method: "POST",
      url: "/api/drawing-plans",
      headers,
      payload: body,
    });
    assert.equal(created.statusCode, 200, created.body);
    const plan = created.json();
    assert.equal(dispatched, 0, "Planning must not draw");
    assert.equal(plan.segmentCount, 4);
    assert.deepEqual(plan.setupActions, [
      "Select Pencil",
      "Select black color",
    ]);
    assert.deepEqual(plan.task.effects, ["edit"]);
    store.db.prepare("DELETE FROM kv WHERE namespace='api-dedup'").run();
    const retry = await app.inject({
      method: "POST",
      url: "/api/drawing-plans",
      headers,
      payload: body,
    });
    assert.equal(retry.json().id, plan.id);
    assert.equal(calls, 1);
    const execution = await app.inject({
      method: "POST",
      url: `/api/drawing-plans/${plan.id}/execute`,
      headers: { ...headers, "idempotency-key": "execute" },
      payload: {},
    });
    assert.equal(execution.statusCode, 200, execution.body);
    await runtime.execute(plan.id);
    assert.equal(
      store.run(plan.id).status,
      "needs_review",
      JSON.stringify(store.run(plan.id)),
    );
    assert.equal(dispatched, 6);
    assert.equal(store.run(plan.id).status, "needs_review");
    assert.ok(store.run(plan.id).bindings.verifiedApplicationResult);
    assert.equal(
      store
        .events(0, plan.id)
        .some(
          (event) =>
            event.type === "completed" &&
            (event.data as any).status === "succeeded",
        ),
      false,
    );
    const altered = structuredClone(plan.task);
    altered.effects.push("save");
    await assert.rejects(() => router.prepare(altered), /frozen approved plan/);
    const observation = await native.observe();
    const action: Action = {
      schemaVersion: 1,
      id: "action",
      runId: plan.id,
      requester: plan.task.requester,
      host: observation.host,
      session: observation.session,
      target: "1",
      observationId: observation.id,
      revision: observation.revision,
      frame: { ...frame, x: 11 },
      operation: "drag",
      args: { x: 20, y: 20, dx: 40, dy: 40 },
      deadline: Date.now() + 1000,
      scope: "edit",
      generation: 1,
    };
    assert.equal(plan.task.parameters.drawingFrame, canonical(frame));
    assert.throws(
      () =>
        new Policy().authorize(
          plan.task,
          { ...action, frame: { ...frame, x: 11 } },
          { ...observation, frame: { ...frame, x: 11 } },
        ),
      /canvas moved or resized/,
    );
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/desktop/tasks/${plan.id}/review`,
      headers: { ...headers, "idempotency-key": "confirm" },
      payload: { command: "confirm" },
    });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(store.run(plan.id).status, "completed_by_user");
  } finally {
    await app.close();
  }
});
