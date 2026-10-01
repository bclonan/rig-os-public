import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NativeClient } from "../src/adapters/native.js";
import { DesktopRouter } from "../src/adapters/desktop.js";
import { launchDesktopApp } from "../src/adapters/desktop-apps.js";
import { Runtime } from "../src/runtime/index.js";
import { service } from "../src/service/index.js";
import { Store, hash } from "../src/storage/index.js";

// Two stages keep approval concrete. Planning writes a preview and sends no
// input. The separate --approve command executes only that frozen plan.
assert.equal(process.platform, "win32", "Requires interactive Windows Paint");
const approved = process.argv[2] === "--approve";
const directory = approved
  ? resolve(process.argv[3] || "")
  : mkdtempSync(join(tmpdir(), "cur-provider-drawing-"));
const marker = join(directory, "owned-verification.json");
if (approved) {
  assert.ok(basename(directory).startsWith("cur-provider-drawing-"));
  assert.equal(resolve(directory, ".."), resolve(tmpdir()));
  assert.ok(existsSync(marker), "Use the store returned by the planning stage");
}
const store = new Store(join(directory, "store"));
const router = new DesktopRouter(store);
await router.start();
const runtime = new Runtime(store, router);
const app = await service(runtime);
const headers = {
  host: "127.0.0.1",
  authorization: "Bearer " + store.token(),
  "idempotency-key": randomUUID(),
  "x-correlation-id": randomUUID(),
};
try {
  if (!approved) {
    let window: any;
    if (process.env.CUR_PAINT_RECEIPT) {
      const receipt = JSON.parse(
        readFileSync(process.env.CUR_PAINT_RECEIPT, "utf8"),
      );
      assert.ok(!receipt.priorHandles.includes(receipt.window.handle));
      window = (await router.native!.client.call("windows")).find(
        (entry: any) =>
          entry.handle === receipt.window.handle &&
          entry.pid === receipt.window.pid &&
          entry.title === receipt.window.title,
      );
    } else {
      const probe = new NativeClient();
      try {
        const prior = new Set(
          (await probe.call("windows")).map((entry: any) => entry.handle),
        );
        await launchDesktopApp("paint");
        for (let i = 0; i < 50 && !window; i++) {
          await delay(200);
          window = (await probe.call("windows")).find(
            (entry: any) =>
              !prior.has(entry.handle) && entry.title === "Untitled - Paint",
          );
        }
      } finally {
        await probe.close();
      }
    }
    assert.ok(window, "A separately owned Paint window is required");
    const response = await app.inject({
      method: "POST",
      url: "/api/drawing-plans",
      headers,
      payload: {
        goal: "Draw a recognizable dog in side profile. Do not save, import or upload an image.",
        handle: window.handle,
        pid: window.pid,
        providers: [
          {
            provider: "ollama",
            model: process.env.CUR_DRAWING_MODEL || "qwen3.6:latest",
          },
        ],
        strategy: "fallback",
        allowRemote: false,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    const plan = response.json();
    writeFileSync(marker, JSON.stringify({ planId: plan.id, window }, null, 2));
    writeFileSync(join(directory, "plan.json"), JSON.stringify(plan, null, 2));
    writeFileSync(
      join(directory, "before.png"),
      store.artifactRead(String(plan.initialObservation.facts.canvasImage)),
    );
    const strokes = plan.construction.strokes.strokes as number[][][];
    const paths = strokes
      .map(
        (stroke) =>
          `<polyline points="${stroke.map(([x, y]) => `${x * 1000},${y * 700}`).join(" ")}" fill="none" stroke="black" stroke-width="2"/>`,
      )
      .join("");
    writeFileSync(
      join(directory, "preview.svg"),
      `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="1000" height="700" fill="white"/>${paths}</svg>`,
    );
    console.log(
      JSON.stringify({
        phase: "preview",
        directory,
        planId: plan.id,
        segments: plan.segmentCount,
        setupActions: plan.setupActions,
        nativeInputs: 0,
        providerResults: plan.providerResults,
      }),
    );
  } else {
    const ownership = JSON.parse(readFileSync(marker, "utf8"));
    const plan = store.get<any>("drawing-plans", ownership.planId);
    assert.ok(
      plan?.ready &&
        plan.task.target.identity === String(ownership.window.handle),
    );
    const window = (await router.native!.client.call("windows")).find(
      (entry: any) =>
        entry.handle === ownership.window.handle &&
        entry.pid === ownership.window.pid &&
        entry.title === ownership.window.title,
    );
    assert.ok(
      window,
      "The owned Paint window must still match before approval",
    );
    const response = await app.inject({
      method: "POST",
      url: `/api/drawing-plans/${plan.id}/execute`,
      headers,
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    await runtime.execute(plan.id);
    const run = store.run(plan.id);
    const events = store.events(0, plan.id);
    writeFileSync(
      join(directory, "execution.json"),
      JSON.stringify({ run, events }, null, 2),
    );
    assert.equal(
      run.status,
      "needs_review",
      run.error || "Drawing must finish with human review",
    );
    const acknowledged = events.filter(
      (entry) => entry.type === "acknowledged",
    );
    assert.equal(acknowledged.length, plan.segmentCount + 2);
    assert.equal(
      events.filter((entry) => entry.type === "uncertain").length,
      0,
    );
    const observation = await runtime.configureEnvironment(async () => {
      await router.prepare(plan.task);
      return runtime.observe(plan.task);
    });
    const bytes = store.artifactRead(String(observation.facts.canvasImage));
    writeFileSync(join(directory, "canvas.png"), bytes);
    assert.notEqual(hash(bytes), plan.initialObservation.facts.canvasImage);
    console.log(
      JSON.stringify({
        phase: "drawn",
        directory,
        planId: plan.id,
        status: run.status,
        acknowledgedInputs: acknowledged.length,
        canvasHash: hash(bytes),
        semanticCompletion:
          "requires human review or separate model assessment",
        image: join(directory, "canvas.png"),
      }),
    );
  }
} finally {
  await app.close();
}
