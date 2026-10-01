import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Store } from "../src/storage/index.js";
import type { Action } from "../src/contracts/index.js";

async function input(
  adapter: BrowserAdapter,
  operation: Action["operation"],
  args: Action["args"],
) {
  const observed = await adapter.observe();
  return adapter.execute({
    schemaVersion: 1,
    id: randomUUID(),
    runId: "owned-input",
    requester: "cleanup-test",
    host: observed.host,
    session: observed.session,
    target: observed.target,
    observationId: observed.id,
    revision: observed.revision,
    frame: observed.frame,
    operation,
    args,
    deadline: Date.now() + 2000,
    scope: "edit",
    generation: await adapter.acquire("owned-input"),
  });
}

test("browser Return releases actual held input before admitting another lease", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-browser-cleanup-")));
  const adapter = await new BrowserAdapter(store).start();
  const originalUp = adapter.page.keyboard.up.bind(adapter.page.keyboard);
  let rejectUp = true;
  adapter.page.keyboard.up = async (key) => {
    if (rejectUp) throw new Error("Injected browser key-up refusal");
    return originalUp(key);
  };
  try {
    await adapter.page.evaluate(() => {
      (window as any).ownedHeld = new Set<string>();
      document.addEventListener("keydown", (event) =>
        (window as any).ownedHeld.add(event.key),
      );
      document.addEventListener("keyup", (event) =>
        (window as any).ownedHeld.delete(event.key),
      );
    });
    const observation = await adapter.observe();
    const generation = await adapter.acquire("cleanup-owner");
    await assert.rejects(
      () =>
        adapter.execute({
          schemaVersion: 1,
          id: randomUUID(),
          runId: "cleanup-owner",
          requester: "input-cleanup-test",
          host: observation.host,
          session: observation.session,
          target: observation.target,
          observationId: observation.id,
          revision: observation.revision,
          frame: observation.frame,
          operation: "hold",
          args: { key: "Shift", ms: 1 },
          deadline: Date.now() + 2000,
          scope: "edit",
          generation,
        }),
      /key-up refusal/,
    );
    assert.equal(
      await adapter.page.evaluate(() => (window as any).ownedHeld.has("Shift")),
      true,
    );
    await assert.rejects(() => adapter.returnControl(), /key-up refusal/);
    await assert.rejects(
      () => adapter.acquire("cleanup-owner"),
      /Manual takeover/,
    );
    rejectUp = false;
    await adapter.returnControl();
    assert.equal(
      await adapter.page.evaluate(() => (window as any).ownedHeld.size),
      0,
    );
    assert.ok(await adapter.acquire("new-owner"));
    await adapter.release("new-owner");
  } finally {
    rejectUp = false;
    await adapter.close();
    store.close();
  }
});

test("lost browser down replies and invalid chords still release delivered modifiers", async () => {
  for (const mode of ["hold-down-reply", "press-down-reply", "invalid-chord"]) {
    const store = new Store(mkdtempSync(join(tmpdir(), "cur-browser-down-")));
    const adapter = await new BrowserAdapter(store).start();
    try {
      await adapter.page.evaluate(() => {
        (window as any).ownedHeld = new Set<string>();
        document.addEventListener("keydown", (e) =>
          (window as any).ownedHeld.add(e.key),
        );
        document.addEventListener("keyup", (e) =>
          (window as any).ownedHeld.delete(e.key),
        );
      });
      const down = adapter.page.keyboard.down.bind(adapter.page.keyboard);
      adapter.page.keyboard.down = async (key) => {
        await down(key);
        if (mode !== "invalid-chord")
          throw new Error("Injected lost down reply after delivery");
      };
      const operation = mode === "hold-down-reply" ? "hold" : "key";
      const key =
        mode === "invalid-chord" ? "Control+NotARealBrowserKey" : "Control";
      await assert.rejects(
        () => input(adapter, operation, { key, ms: 1 }),
        /lost down reply|Unknown key/,
      );
      await adapter.release("owned-input");
      await adapter.returnControl();
      assert.equal(
        await adapter.page.evaluate(() => (window as any).ownedHeld.size),
        0,
        mode,
      );
      assert.ok(await adapter.acquire("next-input"));
    } finally {
      await adapter.close();
      store.close();
    }
  }
});

test("lost browser mouse-down replies remain tracked until cleanup succeeds", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-browser-mouse-")));
  const adapter = await new BrowserAdapter(store).start();
  const down = adapter.page.mouse.down.bind(adapter.page.mouse);
  const up = adapter.page.mouse.up.bind(adapter.page.mouse);
  let refuseUp = true;
  try {
    await adapter.page.evaluate(() => {
      (window as any).ownedMouseHeld = false;
      document.addEventListener(
        "mousedown",
        () => ((window as any).ownedMouseHeld = true),
      );
      document.addEventListener(
        "mouseup",
        () => ((window as any).ownedMouseHeld = false),
      );
    });
    adapter.page.mouse.down = async (options) => {
      await down(options);
      throw new Error("Injected lost mouse-down reply after delivery");
    };
    adapter.page.mouse.up = async (options) => {
      if (refuseUp) throw new Error("Injected mouse-up refusal");
      return up(options);
    };
    await assert.rejects(
      () => input(adapter, "drag", { x: 10, y: 10, dx: 30, dy: 20 }),
      /mouse-up refusal/,
    );
    assert.equal(
      await adapter.page.evaluate(() => (window as any).ownedMouseHeld),
      true,
    );
    await assert.rejects(() => adapter.returnControl(), /mouse-up refusal/);
    await assert.rejects(
      () => adapter.acquire("owned-input"),
      /Manual takeover/,
    );
    refuseUp = false;
    await adapter.returnControl();
    assert.equal(
      await adapter.page.evaluate(() => (window as any).ownedMouseHeld),
      false,
    );
    assert.ok(await adapter.acquire("next-input"));
  } finally {
    refuseUp = false;
    await adapter.close();
    store.close();
  }
});
