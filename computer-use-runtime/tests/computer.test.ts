import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/storage/index.js";
import {
  ComputerAdapter,
  type DesktopWindow,
} from "../src/adapters/computer.js";
import { Runtime } from "../src/runtime/index.js";
import { actionStep, type Decision } from "../src/assistant/planner.js";
import { reviewDesktop, type Proposal } from "../src/assistant/runner.js";
import { Lease } from "../src/runtime/policy.js";
import type {
  Action,
  Observation,
  Receipt,
  TaskContract,
} from "../src/contracts/index.js";
import { supportedWindow } from "../src/adapters/desktop.js";

class NativeDouble {
  host = "test-host";
  session = "windows-test";
  identity = "0";
  capabilities = ["fill"];
  lease = new Lease();
  dispatched: Action[] = [];
  focused: string[] = [];
  foreground = true;
  values = new Map<string, string>();
  async setTarget(handle: number, _pid: number) {
    this.identity = String(handle);
  }
  async observe(): Promise<Observation> {
    return {
      schemaVersion: 1,
      id: randomUUID(),
      host: this.host,
      session: this.session,
      target: this.identity,
      at: Date.now(),
      revision: randomUUID(),
      focused: this.foreground,
      frame: { x: 0, y: 0, width: 400, height: 300, scale: 1 },
      facts: {
        windowHandle: Number(this.identity),
        windowTitle: `App ${this.identity}`,
      },
      controls: [
        {
          index: 0,
          id: "editor",
          name: "Editor",
          value: this.values.get(this.identity) || "",
          controlType: 50004,
          focused: true,
          offscreen: false,
          actions: ["fill"],
          bounds: { x: 0, y: 0, width: 300, height: 200 },
        },
      ],
      features: [],
      backend: "test-double",
    };
  }
  async focus() {
    this.focused.push(this.identity);
  }
  async acquire(id: string) {
    return this.lease.acquire(id);
  }
  async execute(action: Action): Promise<Receipt> {
    this.lease.check(action);
    assert.equal(action.target, this.identity);
    this.dispatched.push(action);
    this.values.set(this.identity, String(action.args.value));
    return {
      schemaVersion: 1,
      actionId: action.id,
      runId: action.runId,
      at: Date.now(),
      phase: "acknowledged",
      backend: "test-double",
      detail: "delivered",
      timings: {},
    };
  }
  async release(id: string) {
    this.lease.release(id);
  }
  async takeover() {
    this.lease.takeover();
  }
  async returnControl() {
    this.lease.returnControl();
  }
  async close() {}
}
function setup() {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-computer-test-")));
  const native = new NativeDouble();
  const windows: DesktopWindow[] = [
    {
      id: "1:10",
      handle: 1,
      pid: 10,
      title: "Calculator",
      executable: "calculatorapp.exe",
    },
    {
      id: "2:20",
      handle: 2,
      pid: 20,
      title: "Empty document",
      executable: "notepad.exe",
    },
  ];
  const launches: string[] = [];
  const adapter = new ComputerAdapter(store, native, {
    windows: async () => structuredClone(windows),
    apps: () => [
      { id: "notepad", name: "Notepad", executables: ["notepad.exe"] },
    ],
    launch: async (id) => {
      launches.push(id);
    },
  });
  let next: Decision = {
    kind: "action",
    summary: "Read Calculator",
    operation: "switch_window",
    window: "1:10",
  };
  const runtime = new Runtime(store, adapter, undefined, undefined, undefined, {
    next: async () => next,
  });
  const id = randomUUID();
  const task: TaskContract = {
    schemaVersion: 1,
    id,
    correlationId: id,
    requester: "user",
    goal: "Work across apps",
    target: {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    parameters: { desktopScope: "computer" },
    effects: ["edit", "save", "navigate"],
    requirements: [],
    unresolved: [],
    method: "desktop.assistant",
    expected: {},
    budgets: { steps: 20, deadlineMs: 60000 },
  };
  runtime.submit(task, id);
  const approve = async () => {
    const proposal = store.run(id).bindings.proposal as Proposal;
    await reviewDesktop(runtime, id, {
      command: "approve",
      proposalId: proposal.id,
    });
    await runtime.execute(id);
  };
  return {
    store,
    native,
    adapter,
    runtime,
    task,
    id,
    windows,
    launches,
    approve,
    next: (d: Decision) => {
      next = d;
    },
  };
}
test("computer navigation requires review, preserves immutable scope and rebinds every input to the selected native window", async () => {
  const s = setup();
  try {
    await s.runtime.execute(s.id);
    assert.equal(s.native.focused.length, 0);
    assert.equal(s.native.dispatched.length, 0);
    s.next({
      kind: "action",
      summary: "Write result",
      operation: "fill",
      control: 0,
      text: "518",
    });
    await s.approve();
    assert.equal(s.store.run(s.id).bindings.activeWindow, "1:10");
    s.next({
      kind: "action",
      summary: "Move to document",
      operation: "switch_window",
      window: "2:20",
    });
    await s.approve();
    assert.equal(s.native.dispatched[0].target, "1");
    s.next({
      kind: "action",
      summary: "Copy result",
      operation: "fill",
      control: 0,
      text: "518",
    });
    await s.approve();
    s.next({ kind: "done", summary: "Result copied" });
    await s.approve();
    assert.equal(s.native.values.get("2"), "518");
    assert.equal(s.native.dispatched[1].target, "2");
    assert.deepEqual(s.store.run(s.id).contract, s.task);
    assert.equal(s.store.run(s.id).status, "needs_review");
    const actions = s.store
      .events(0, s.id)
      .filter((e) => e.type === "assistant_action");
    assert.equal(actions.length, 4);
  } finally {
    await s.runtime.close();
  }
});
test("reviewed app navigation works without foreground focus while ordinary input stays blocked", async () => {
  const s = setup();
  s.native.foreground = false;
  try {
    await s.runtime.execute(s.id);
    s.next({
      kind: "action",
      summary: "Select editor",
      operation: "switch_window",
      window: "2:20",
    });
    await s.approve();
    s.next({
      kind: "action",
      summary: "Write",
      operation: "fill",
      control: 0,
      text: "test",
    });
    await s.approve();
    assert.equal(s.store.run(s.id).bindings.activeWindow, "2:20");
    assert.equal(s.store.run(s.id).status, "awaiting_approval");
    s.next({ kind: "done", summary: "Never reached" });
    await s.approve();
    assert.equal(s.store.run(s.id).status, "blocked");
    assert.match(s.store.run(s.id).error || "", /focus loss/);
    assert.equal(s.native.dispatched.length, 0);
  } finally {
    await s.runtime.close();
  }
});

test("a recycled window handle or changed destination invalidates app-switch approval", async () => {
  const s = setup();
  try {
    await s.runtime.execute(s.id);
    s.windows[0] = { ...s.windows[0], id: "1:99", pid: 99 };
    s.next({ kind: "question", summary: "Calculator has closed" });
    await s.approve();
    assert.equal(s.native.focused.length, 0);
    assert.equal(s.native.dispatched.length, 0);
    assert.ok(
      s.store.events(0, s.id).some((e) => e.type === "proposal_expired"),
    );
  } finally {
    await s.runtime.close();
  }
});
test("computer scope rejects wrong host, session and identity; a window task cannot acquire navigation operations", async () => {
  const s = setup();
  try {
    for (const [field, value] of [
      ["host", "other"],
      ["session", "other"],
      ["identity", "1"],
    ]) {
      await assert.rejects(
        s.adapter.prepare({
          ...s.task,
          target: { ...s.task.target, [field]: value },
        }),
        /mismatch/,
      );
    }
    const observation = await s.native.observe();
    assert.throws(
      () =>
        actionStep(
          {
            kind: "action",
            summary: "Open app",
            operation: "launch_app",
            app: "notepad",
          },
          observation,
          false,
        ),
      /computer scope/,
    );
    await s.adapter.prepare(s.task);
    const computer = await s.adapter.observe();
    assert.throws(
      () =>
        actionStep(
          {
            kind: "action",
            summary: "Run program",
            operation: "launch_app",
            app: "powershell.exe",
          },
          computer,
          false,
        ),
      /launcher/,
    );
    assert.throws(
      () =>
        actionStep(
          { kind: "action", summary: "Type", operation: "type", text: "hello" },
          computer,
          false,
        ),
      /Switch/,
    );
    assert.equal(
      supportedWindow({
        title: "Terminal",
        executable: "C:\\Windows\\cmd.exe",
      }),
      false,
    );
  } finally {
    await s.runtime.close();
  }
});
test("app launch is reviewed once, and resuming a task restores its selected app", async () => {
  const s = setup();
  try {
    s.next({
      kind: "action",
      summary: "Open Notepad",
      operation: "launch_app",
      app: "notepad",
    });
    await s.runtime.execute(s.id);
    assert.deepEqual(s.launches, []);
    s.next({ kind: "done", summary: "App opened" });
    await s.approve();
    assert.deepEqual(s.launches, ["notepad"]);
    assert.equal(s.store.run(s.id).bindings.activeWindow, "2:20");
    s.native.identity = "1";
    await s.adapter.prepare(s.store.run(s.id).contract);
    assert.equal(s.native.identity, "2");
    await s.runtime.control(s.id, "pause");
    await s.runtime.control(s.id, "resume");
    await s.runtime.execute(s.id);
    assert.deepEqual(s.launches, ["notepad"]);
  } finally {
    await s.runtime.close();
  }
});
test("manual takeover revokes computer navigation until control is returned", async () => {
  const s = setup();
  try {
    await s.adapter.prepare(s.task);
    await s.adapter.takeover();
    await assert.rejects(s.adapter.acquire(s.id), /takeover/);
    await s.adapter.returnControl();
    await s.adapter.acquire(s.id);
    await s.adapter.release(s.id);
  } finally {
    await s.runtime.close();
  }
});
test("closing the selected app returns to the computer catalog without sending input elsewhere", async () => {
  const s = setup();
  try {
    await s.runtime.execute(s.id);
    s.next({
      kind: "action",
      summary: "Edit Calculator",
      operation: "fill",
      control: 0,
      text: "518",
    });
    await s.approve();
    s.windows.splice(0, 1);
    s.next({
      kind: "question",
      summary: "The selected app closed. Choose another app.",
    });
    await s.approve();
    assert.equal(s.native.dispatched.length, 0);
    assert.equal(s.store.run(s.id).bindings.activeWindow, undefined);
    assert.equal((await s.adapter.observe()).desktop?.activeWindow, undefined);
    assert.equal(s.store.run(s.id).status, "awaiting_input");
  } finally {
    await s.runtime.close();
  }
});
test("hosted security apps remain excluded even when their root is ApplicationFrameHost", () => {
  assert.equal(
    supportedWindow({
      title: "Settings",
      executable: "C:\\Windows\\System32\\ApplicationFrameHost.exe",
      appExecutable: "C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe",
    }),
    false,
  );
  assert.equal(
    supportedWindow({
      title: "Calculator",
      executable: "C:\\Windows\\System32\\ApplicationFrameHost.exe",
      appExecutable: "C:\\Program Files\\WindowsApps\\CalculatorApp.exe",
    }),
    true,
  );
});
