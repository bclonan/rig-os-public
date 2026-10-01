import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeClient,
  NativeDeadlineError,
  WindowsAdapter,
} from "../src/adapters/native.js";
import { Store, hash } from "../src/storage/index.js";
import { checkOculixResult } from "../src/adapters/oculix.js";
import { screenshotTensor } from "../src/learner/image.js";

test("coherent native capture uses matching boundary frames without retaining stale facts or another invocation", async () => {
  for (const mode of [
    "boundary",
    "controls-change",
    "text-change",
    "frame-change",
    "focus-change",
    "target-change",
    "captured-pid-change",
    "cancel",
    "deadline",
    "next-invocation",
  ] as const) {
    const store = new Store(
      mkdtempSync(join(tmpdir(), "cur-native-boundary-")),
    );
    const abort = new AbortController();
    const expired = new NativeDeadlineError("Boundary capture deadline");
    const calls: string[] = [];
    let captures = 0,
      controls = 0,
      texts = 0;
    const client = {
      async call(method: string, params: any = {}) {
        calls.push(method);
        if (method === "capabilities")
          return { host: "test", session: "desktop", operations: ["observe"] };
        if (method === "windows") return [{ handle: 1, pid: 9 }];
        if (method === "resolve_target")
          return { handle: mode === "target-change" && captures >= 2 ? 2 : 1 };
        if (method === "fixture_text")
          return { text: mode === "text-change" ? String(++texts) : "same" };
        if (method === "accessibility")
          return [
            {
              id: "label",
              value: mode === "controls-change" ? String(++controls) : "same",
            },
          ];
        if (method !== "observe") throw new Error("Unexpected input " + method);
        captures++;
        if (captures === 3 && mode === "deadline") throw expired;
        if (captures === 3 && mode === "cancel") abort.abort();
        // Ordinary pairs A/B, B/A never match. Their boundary B/B does.
        const white =
          mode === "next-invocation"
            ? captures > 1 &&
              (captures <= 4 || Math.floor((captures - 5) / 2) % 2 === 1)
            : Math.floor(captures / 2) % 2 === 1;
        const bitmap = Buffer.alloc(58);
        bitmap.write("BM");
        bitmap.writeUInt32LE(58, 2);
        bitmap.writeUInt32LE(54, 10);
        bitmap.writeUInt32LE(40, 14);
        bitmap.writeInt32LE(1, 18);
        bitmap.writeInt32LE(-1, 22);
        bitmap.writeUInt16LE(1, 26);
        bitmap.writeUInt16LE(32, 28);
        bitmap.fill(white ? 255 : 0, 54);
        return {
          id: "capture" + captures,
          host: "test",
          session: "desktop",
          target: params.handle,
          pid: mode === "captured-pid-change" ? captures + 8 : 9,
          at: Date.now(),
          revision: hash(bitmap),
          focused: mode === "focus-change" ? captures % 2 === 0 : true,
          title: "Owned test window",
          frame: {
            x: mode === "frame-change" ? captures : 0,
            y: 0,
            width: 1,
            height: 1,
            scale: 1,
          },
          image: bitmap.toString("base64"),
        };
      },
      async close() {},
    };
    const adapter = new WindowsAdapter(
      store,
      false,
      client as unknown as NativeClient,
    );
    try {
      await adapter.start(1);
      calls.length = 0;
      if (mode === "boundary" || mode === "next-invocation") {
        const first = await adapter.observe(abort.signal);
        assert.equal(
          first.id,
          "capture3",
          "Return the current bound native observation",
        );
        assert.equal(first.facts["uia.label"], "same");
        if (mode === "next-invocation") {
          const second = await adapter.observe();
          assert.equal(
            second.id,
            "capture6",
            "A new observe needs its own complete coherence interval",
          );
        }
      } else if (mode === "target-change") {
        const observed = await adapter.observe();
        assert.equal(
          observed.id,
          "capture5",
          "A prior target's matching pixels cannot confirm the new target",
        );
        assert.equal(observed.facts.windowHandle, 2);
      } else if (mode === "deadline") {
        await assert.rejects(
          () => adapter.observe(),
          (error: unknown) => error === expired,
        );
        assert.equal(calls.at(-1), "observe");
      } else if (mode === "cancel") {
        await assert.rejects(() => adapter.observe(abort.signal), /abort/i);
        assert.equal(captures, 3);
      } else {
        await assert.rejects(() => adapter.observe(), /kept changing/);
        assert.ok(captures <= 24);
      }
      assert.equal(calls.includes("execute"), false);
    } finally {
      await adapter.close();
      store.close();
    }
  }
});

test("optional native fact deadlines stop capture and retain the original error", async () => {
  for (const failing of ["fixture_text", "accessibility", "observe"]) {
    const store = new Store(
      mkdtempSync(join(tmpdir(), "cur-native-deadline-")),
    );
    const calls: string[] = [];
    const deadline = new NativeDeadlineError(`Deadline in ${failing}`);
    const client = {
      async call(method: string) {
        calls.push(method);
        if (method === "capabilities")
          return { host: "test", session: "desktop", operations: ["observe"] };
        if (method === "windows") return [{ handle: 1, pid: 9 }];
        if (method === "resolve_target") return { handle: 1 };
        if (method === failing) throw deadline;
        if (method === "fixture_text") return {};
        if (method === "accessibility") return [];
        throw new Error("Unexpected later native call " + method);
      },
      async close() {},
    };
    const adapter = new WindowsAdapter(
      store,
      false,
      client as unknown as NativeClient,
    );
    try {
      await adapter.start(1);
      calls.length = 0;
      await assert.rejects(
        () => adapter.observe(),
        (error: unknown) => error === deadline,
      );
      assert.equal(calls.at(-1), failing);
      assert.equal(calls.includes("execute"), false);
    } finally {
      await adapter.close();
      store.close();
    }
  }
});

test("read-only settling tolerates a slow transition, bounds changing captures and rejects PID change or cancellation", async () => {
  for (const mode of ["settle", "changing", "pid-change", "cancel"] as const) {
    const store = new Store(
      mkdtempSync(join(tmpdir(), "cur-native-settling-")),
    );
    const abort = new AbortController();
    let captures = 0,
      pid = 9;
    const calls: string[] = [],
      timeouts: number[] = [];
    const client = {
      async call(method: string, _params: unknown = {}, timeout = 10000) {
        calls.push(method);
        timeouts.push(timeout);
        if (method === "capabilities")
          return { host: "test", session: "desktop", operations: ["observe"] };
        if (method === "windows") return [{ handle: 1, pid }];
        if (method === "resolve_target") return { handle: 1 };
        if (method === "fixture_text") return {};
        if (method === "accessibility") return [];
        if (method !== "observe") throw new Error("Unexpected input " + method);
        captures++;
        if (captures === 2 && mode === "pid-change") pid = 10;
        if (captures === 2 && mode === "cancel") abort.abort();
        const changing =
          mode === "changing" || (mode === "settle" && captures <= 12);
        const white = !changing || captures % 2 === 0;
        const bitmap = Buffer.alloc(58, 0);
        bitmap.write("BM");
        bitmap.writeUInt32LE(58, 2);
        bitmap.writeUInt32LE(54, 10);
        bitmap.writeUInt32LE(40, 14);
        bitmap.writeInt32LE(1, 18);
        bitmap.writeInt32LE(-1, 22);
        bitmap.writeUInt16LE(1, 26);
        bitmap.writeUInt16LE(32, 28);
        bitmap.fill(white ? 255 : 0, 54);
        return {
          id: "capture" + captures,
          host: "test",
          session: "desktop",
          at: Date.now(),
          revision: white ? "white" : "black",
          focused: true,
          title: "Owned test window",
          frame: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
          image: bitmap.toString("base64"),
        };
      },
      async close() {},
    };
    const adapter = new WindowsAdapter(
      store,
      false,
      client as unknown as NativeClient,
    );
    try {
      await adapter.start(1);
      calls.length = 0;
      timeouts.length = 0;
      if (mode === "settle") {
        const observation = await adapter.observe(abort.signal);
        assert.equal(captures, 13);
        assert.equal(observation.id, "capture13");
      } else if (mode === "changing") {
        await assert.rejects(
          () => adapter.observe(abort.signal),
          /kept changing/,
        );
        assert.equal(captures, 24);
      } else if (mode === "pid-change") {
        await assert.rejects(
          () => adapter.observe(abort.signal),
          /changed process/,
        );
        assert.equal(captures, 2);
      } else {
        await assert.rejects(() => adapter.observe(abort.signal), /abort/i);
        assert.equal(captures, 2);
      }
      assert.equal(calls.includes("execute"), false);
      assert.ok(timeouts.every((timeout) => timeout > 0 && timeout <= 5000));
    } finally {
      await adapter.close();
      store.close();
    }
  }
});

test("a closing owned dialog retries capture without repeating input, and changed PIDs are rejected", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-dialog-race-")));
  const commands: string[] = [];
  let active = 2,
    pid = 91;
  const client = {
    async call(method: string, params: any = {}) {
      commands.push(method);
      if (method === "capabilities")
        return { host: "test", session: "session", operations: ["observe"] };
      if (method === "windows") return [{ handle: 1, pid }];
      if (method === "resolve_target") return { handle: active };
      if (method === "fixture_text") return {};
      if (method === "accessibility") return [];
      if (method === "observe") {
        if (params.handle === 2) {
          active = 1;
          throw new Error("Stale target");
        }
        return {
          id: "capture",
          host: "test",
          session: "session",
          at: Date.now(),
          revision: "one",
          focused: true,
          title: "Owned test document",
          frame: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
          image: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString(
            "base64",
          ),
        };
      }
      throw new Error("Unexpected native operation " + method);
    },
    async close() {},
  };
  const adapter = new WindowsAdapter(
    store,
    false,
    client as unknown as NativeClient,
  );
  try {
    await adapter.start(1);
    const observation = await adapter.observe();
    assert.equal(observation.facts.ownedDialog, false);
    assert.equal(commands.filter((command) => command === "observe").length, 3);
    assert.equal(commands.includes("execute"), false);
    pid = 92;
    await assert.rejects(() => adapter.observe(), /changed process/);
  } finally {
    await adapter.close();
    store.close();
  }
});

test("the adapter scopes semantic pixels to a unique canvas and excludes outside content at fractional boundaries", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-canvas-scope-")));
  const bitmap = Buffer.alloc(54 + 6 * 4 * 4, 255);
  bitmap.write("BM");
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(6, 18);
  bitmap.writeInt32LE(-4, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(32, 28);
  bitmap.writeUInt32LE(0, 30);
  // Only columns1 and2 are canvas pixels. Outside pixels deliberately differ.
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 6; x++)
      if (x !== 1 && x !== 2)
        bitmap.fill(0, 54 + (y * 6 + x) * 4, 54 + (y * 6 + x) * 4 + 3);
  let duplicate = false;
  const canvas = {
    index: 0,
    id: "image",
    name: "owned canvas",
    value: "",
    focused: true,
    offscreen: false,
    controlType: 50032,
    bounds: { x: 100.2, y: 200, width: 2.8, height: 4 },
  };
  const client = {
    async call(method: string) {
      if (method === "capabilities")
        return { host: "test", session: "desktop", operations: ["observe"] };
      if (method === "windows") return [{ handle: 1, pid: 9 }];
      if (method === "resolve_target") return { handle: 1 };
      if (method === "fixture_text") return {};
      if (method === "accessibility")
        return duplicate ? [canvas, { ...canvas, index: 1 }] : [canvas];
      if (method === "observe")
        return {
          id: "native-confirmation",
          host: "test",
          session: "desktop",
          at: Date.now(),
          revision: "raw-scope",
          focused: true,
          title: "owned",
          frame: { x: 100, y: 200, width: 6, height: 4, scale: 1 },
          image: bitmap.toString("base64"),
        };
      throw new Error("Unexpected operation " + method);
    },
    async close() {},
  };
  const adapter = new WindowsAdapter(
    store,
    false,
    client as unknown as NativeClient,
  );
  try {
    await adapter.start(1);
    const observation = await adapter.observe();
    const cropped = store.artifactRead(String(observation.facts.canvasImage));
    assert.equal(cropped.readUInt32BE(16), 2);
    assert.equal(cropped.readUInt32BE(20), 4);
    assert.ok(
      Array.from(screenshotTensor(cropped)).every((value) => value === 1),
    );
    assert.ok(
      Array.from(screenshotTensor(store.artifactRead(observation.image!))).some(
        (value) => value === 0,
      ),
    );
    duplicate = true;
    const ambiguous = await adapter.observe();
    assert.equal(ambiguous.facts.canvasImage, undefined);
  } finally {
    await adapter.close();
    store.close();
  }
});

test("native startup can enumerate apps before a target is selected", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-unbound-native-")));
  const calls: string[] = [];
  const client = {
    async call(method: string) {
      calls.push(method);
      return { host: "test", session: "desktop", operations: ["observe"] };
    },
    async close() {},
  };
  const adapter = new WindowsAdapter(
    store,
    false,
    client as unknown as NativeClient,
  );
  try {
    await adapter.start(0);
    assert.equal(adapter.identity, "0");
    assert.deepEqual(calls, ["capabilities"]);
  } finally {
    await adapter.close();
    store.close();
  }
});

test("native facts retry when the document changes between text read and image capture", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "cur-capture-coherence-")),
  );
  let text = "old",
    captures = 0;
  const client = {
    async call(method: string) {
      if (method === "capabilities")
        return { host: "test", session: "desktop", operations: ["observe"] };
      if (method === "windows") return [{ handle: 1, pid: 9 }];
      if (method === "resolve_target") return { handle: 1 };
      if (method === "fixture_text") return { text };
      if (method === "accessibility") return [];
      if (method === "observe") {
        captures++;
        text = "new";
        return {
          id: "capture" + captures,
          host: "test",
          session: "desktop",
          at: Date.now(),
          revision: "new",
          focused: true,
          title: "owned",
          frame: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
          image: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString(
            "base64",
          ),
        };
      }
      throw new Error("Unexpected call");
    },
    async close() {},
  };
  const adapter = new WindowsAdapter(
    store,
    false,
    client as unknown as NativeClient,
  );
  try {
    await adapter.start(1);
    const observed = await adapter.observe();
    assert.equal(captures, 3);
    assert.equal(observed.facts.text, "new");
  } finally {
    await adapter.close();
    store.close();
  }
});

test("Oculix declared operation failure never becomes an acknowledged receipt", () => {
  for (const [operation, field] of [
    ["click", "clicked"],
    ["type", "typed"],
    ["key", "pressed"],
    ["scroll", "scrolled"],
  ] as const) {
    assert.throws(
      () =>
        checkOculixResult(operation, {
          content: [{ type: "text", text: JSON.stringify({ [field]: false }) }],
        }),
      /did not acknowledge/,
    );
    assert.throws(
      () =>
        checkOculixResult(operation, {
          content: [{ type: "text", text: "malformed" }],
        }),
      /malformed/,
    );
    checkOculixResult(operation, {
      content: [{ type: "text", text: JSON.stringify({ [field]: true }) }],
    });
  }
});
