import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { NativeClient, WindowsAdapter } from "../src/adapters/native.js";
import { structuredTask } from "../src/compiler/intent.js";
import type { Action, Observation, Receipt } from "../src/contracts/index.js";
import { Runtime } from "../src/runtime/index.js";
import { seal, seedForm } from "../src/skills/index.js";
import { hash, Store } from "../src/storage/index.js";

// Every result comes from Win32 state queried through a separate worker, rather
// than from the dispatch acknowledgement or the adapter's observation facts.
const directory = resolve(
  process.env.CUR_NATIVE_EFFECTS_EVIDENCE ||
    "evidence/completion/native-effects",
  new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID(),
);
mkdirSync(directory, { recursive: true });
const sourcePaths = [
  "evaluation/native-effects.ts",
  "native/src/windows.rs",
  "native/src/fixture.rs",
  "native/src/accessibility.rs",
  "src/adapters/native.ts",
  "src/runtime/index.ts",
  "src/runtime/program.ts",
  "native/target/release/computer-use-native.exe",
  "native/target/release/disposable-editor.exe",
];
const identities = () =>
  Object.fromEntries(
    sourcePaths.map((path) => [path, hash(readFileSync(path))]),
  );
const fingerprint = () =>
  JSON.parse(
    execFileSync(
      process.env.CUR_PYTHON || "python",
      ["scripts/source-identity.py"],
      {
        encoding: "utf8",
      },
    ),
  );
const report: Record<string, any> = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  evidenceLevel: "real Windows input and independent Win32 fixture state",
  status: "NOT RUN",
  checks: [],
  limits: [
    "Disposable editor only; no other application is authorized by this test.",
    "Cancellation waits for the bounded in-flight segment and checks cleanup before returning.",
    "SendInput failure injection and physical device interaction are not tested.",
  ],
};
// This evaluator owns these windows. A separate PowerShell process validates
// their PID and executable before querying or moving either exact HWND.
const monitorProbeSource = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class IndependentWindowProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rectangle);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr handle, int x, int y, int width, int height, bool repaint);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
}
'@
[void][IndependentWindowProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
function Invoke-OwnedWindowProbe($request) {
$screens = @([Windows.Forms.Screen]::AllScreens | ForEach-Object {
  @{ device=$_.DeviceName; primary=$_.Primary; bounds=@{x=$_.Bounds.X;y=$_.Bounds.Y;width=$_.Bounds.Width;height=$_.Bounds.Height}; working=@{x=$_.WorkingArea.X;y=$_.WorkingArea.Y;width=$_.WorkingArea.Width;height=$_.WorkingArea.Height} }
})
if ($request.operation -eq 'inventory') {
  @{screens=$screens} | ConvertTo-Json -Depth 6 -Compress
  return
}
$windowHandle = [IntPtr]::new([long]$request.handle)
[uint32]$windowPid = 0
[void][IndependentWindowProbe]::GetWindowThreadProcessId($windowHandle, [ref]$windowPid)
if ($windowPid -ne [uint32]$request.pid) { throw 'Owned window PID mismatch' }
$ownedProcess = Get-Process -Id $windowPid
if ($ownedProcess.ProcessName -ne 'disposable-editor') { throw 'Unexpected owned executable' }
if ($request.operation -eq 'move') {
  if (-not [IndependentWindowProbe]::MoveWindow($windowHandle, [int]$request.x, [int]$request.y, [int]$request.width, [int]$request.height, $true)) { throw 'MoveWindow failed' }
}
$rectangle = New-Object IndependentWindowProbe+RECT
$cursor = New-Object IndependentWindowProbe+POINT
if (-not [IndependentWindowProbe]::GetWindowRect($windowHandle, [ref]$rectangle)) { throw 'GetWindowRect failed' }
if (-not [IndependentWindowProbe]::GetCursorPos([ref]$cursor)) { throw 'GetCursorPos failed' }
$screen = [Windows.Forms.Screen]::FromHandle($windowHandle)
@{pid=$windowPid;handle=[long]$request.handle;executable=$ownedProcess.Path;dpi=[IndependentWindowProbe]::GetDpiForWindow($windowHandle);frame=@{x=$rectangle.left;y=$rectangle.top;width=$rectangle.right-$rectangle.left;height=$rectangle.bottom-$rectangle.top};cursor=@{x=$cursor.x;y=$cursor.y};monitor=$screen.DeviceName;screens=$screens} | ConvertTo-Json -Depth 6 -Compress
}
[Console]::Out.WriteLine('{"ready":true}')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try { Invoke-OwnedWindowProbe ($line | ConvertFrom-Json) }
  catch { @{error=$_.Exception.Message} | ConvertTo-Json -Compress }
}
`;
const monitorProbePath = join(directory, "independent-window-probe.ps1");
writeFileSync(monitorProbePath, monitorProbeSource);
report.independentProbe = {
  path: monitorProbePath,
  sha256: hash(Buffer.from(monitorProbeSource)),
};
let monitorWorker: ChildProcess | undefined;
let monitorReady: Promise<void> | undefined;
const monitorReplies: {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}[] = [];
const startMonitorProbe = () => {
  monitorWorker = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-File", monitorProbePath],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  monitorReady = new Promise((resolveReady, rejectReady) => {
    monitorWorker!.on("error", rejectReady);
    const lines = createInterface({ input: monitorWorker!.stdout! });
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (value.ready) {
          resolveReady();
          return;
        }
        const pending = monitorReplies.shift();
        if (value.error) pending?.reject(new Error(value.error));
        else pending?.resolve(value);
      } catch (error) {
        rejectReady(error);
      }
    });
    monitorWorker!.stderr!.on("data", (data) => {
      report.independentProbe.stderr =
        (report.independentProbe.stderr || "") + String(data);
    });
    monitorWorker!.on("exit", (code) => {
      rejectReady(new Error("Independent probe exited " + code));
      for (const pending of monitorReplies.splice(0))
        pending.reject(new Error("Independent probe exited " + code));
    });
  });
  return monitorReady;
};
const boundedMonitorReply = <T>(pending: Promise<T>) =>
  new Promise<T>((resolveReply, rejectReply) => {
    const timeout = setTimeout(() => {
      monitorWorker?.kill();
      rejectReply(new Error("Independent window probe timed out after 5000ms"));
    }, 5000);
    pending.then(
      (value) => {
        clearTimeout(timeout);
        resolveReply(value);
      },
      (error) => {
        clearTimeout(timeout);
        rejectReply(error);
      },
    );
  });
const monitorProbe = async (request: Record<string, unknown>) => {
  if (!monitorReady) startMonitorProbe();
  await boundedMonitorReply(monitorReady!);
  return boundedMonitorReply(
    new Promise<any>((resolveReply, rejectReply) => {
      monitorReplies.push({ resolve: resolveReply, reject: rejectReply });
      monitorWorker!.stdin!.write(JSON.stringify(request) + "\n");
    }),
  );
};
let store: Store | undefined;
let adapter: WindowsAdapter | undefined;
let probe: NativeClient | undefined;
let runtime: Runtime | undefined;
const fixtures: ChildProcess[] = [];
let runId = "native-effects-" + randomUUID();
let generation = 0;
let handle = 0;
let otherHandle = 0;
const check = async (
  name: string,
  body: () => Promise<Record<string, unknown>>,
) => {
  const entry: Record<string, unknown> = { name, at: new Date().toISOString() };
  report.checks.push(entry);
  try {
    Object.assign(entry, await body(), { status: "PASS" });
  } catch (error) {
    Object.assign(entry, { status: "FAIL", error: String(error) });
    if (handle && probe) entry.independentStateAtFailure = await state();
    throw error;
  }
};
const state = (target = handle) =>
  probe!.call("fixture_state", { handle: target });
const released = (observed: any) => {
  assert.deepEqual(observed.held, {
    right: false,
    control: false,
    shift: false,
    leftButton: false,
  });
};
const action = (
  observed: Observation,
  operation: string,
  args: Record<string, string | number | boolean>,
): Action => ({
  schemaVersion: 1,
  id: randomUUID(),
  runId,
  requester: "local-user",
  host: adapter!.host,
  session: adapter!.session,
  target: adapter!.identity,
  observationId: observed.id,
  revision: observed.revision,
  frame: observed.frame,
  operation,
  args,
  deadline: Date.now() + 5000,
  scope: "edit",
  generation,
});
const acknowledged = (receipt: Receipt, requested: Action) => {
  assert.equal(receipt.phase, "acknowledged", receipt.detail);
  assert.equal(receipt.actionId, requested.id);
  assert.equal(receipt.runId, requested.runId);
};
const dispatch = async (
  operation: string,
  args: Record<string, string | number | boolean>,
) => {
  const observed = await adapter!.observe();
  const requested = action(observed, operation, args);
  const receipt = await adapter!.execute(requested);
  acknowledged(receipt, requested);
  await delay(50);
  return { requested, receipt, after: await state() };
};
const fill = async (text: string) => {
  await dispatch("fill", { locator: "101", value: text });
  assert.equal((await state()).text, text);
};
const saveImage = async (name: string) => {
  const observed = await adapter!.observe();
  assert.ok(observed.image);
  writeFileSync(join(directory, name), store!.artifactRead(observed.image));
};

try {
  assert.equal(process.platform, "win32", "Windows interactive host required");
  report.sourceBefore = fingerprint();
  report.executionFilesBefore = identities();
  report.binaryHashes = Object.fromEntries(
    sourcePaths
      .filter((path) => path.endsWith(".exe"))
      .map((path) => [path, hash(readFileSync(path))]),
  );
  store = new Store(mkdtempSync(join(tmpdir(), "cur-native-effects-")));
  report.store = store.root;
  probe = new NativeClient();
  const executable = resolve("native/target/release/disposable-editor.exe");
  for (let i = 0; i < 2; i++) {
    const fixture = spawn(executable, [], {
      windowsHide: false,
      stdio: "ignore",
    });
    fixtures.push(fixture);
    fixture.on("error", (error) => {
      report.fixtureSpawnError = String(error);
    });
  }
  let windows: any[] = [];
  const startupDeadline = Date.now() + 6000;
  do {
    windows = await probe.call("windows");
    if (
      fixtures.every((fixture) =>
        windows.some(
          (window) =>
            window.pid === fixture.pid &&
            window.title === "Computer use disposable editor",
        ),
      )
    )
      break;
    await delay(100);
  } while (Date.now() < startupDeadline);
  const owned = fixtures.map((fixture) => {
    const matches = windows.filter(
      (window) =>
        window.pid === fixture.pid &&
        window.title === "Computer use disposable editor",
    );
    assert.equal(matches.length, 1, "Exactly one window per owned fixture");
    return matches[0];
  });
  report.windows = owned;
  handle = owned[0].handle;
  otherHandle = owned[1].handle;
  adapter = await new WindowsAdapter(store, false).start(handle);
  await adapter.focus();
  await delay(500);
  generation = await adapter.acquire(runId);
  report.capabilities = await adapter.client.call("capabilities");
  await saveImage("before.png");

  await check("click focuses edit and changes caret", async () => {
    await fill("abcdefghijklmnopqrstuvwxyz 0123456789");
    await dispatch("key", { key: "Control+End" });
    const before = await state();
    assert.equal(before.selectionStart, before.text.length);
    const observed = await adapter!.observe();
    const x = before.editFrame.x + 12 - observed.frame.x;
    const y = before.editFrame.y + 10 - observed.frame.y;
    const requested = action(observed, "click", { x, y });
    const receipt = await adapter!.execute(requested);
    acknowledged(receipt, requested);
    await delay(50);
    const after = await state();
    assert.equal(after.focusedHandle, after.editHandle);
    assert.deepEqual(after.cursor, {
      x: x + observed.frame.x,
      y: y + observed.frame.y,
    });
    assert.equal(after.selectionStart, after.selectionEnd);
    assert.ok(after.selectionStart < before.selectionStart);
    released(after);
    return { before, after, requested, receipt };
  });

  await check("shortcut selects full text", async () => {
    await dispatch("key", { key: "Control+Home" });
    const before = await state();
    const result = await dispatch("key", { key: "Control+Shift+End" });
    assert.equal(result.after.selectionStart, 0);
    assert.equal(result.after.selectionEnd, before.text.length);
    assert.equal(result.after.text, before.text);
    released(result.after);
    return { before, ...result };
  });

  await check("Unicode typing replaces actual selected text", async () => {
    const text = "Native effect Ω é " + randomUUID().slice(0, 8);
    const result = await dispatch("type", { text });
    assert.equal(result.after.text, text);
    released(result.after);
    return { expectedText: text, ...result };
  });

  await check("held right key changes caret and releases key", async () => {
    await dispatch("key", { key: "Control+Home" });
    const before = await state();
    const result = await dispatch("hold", { key: "ArrowRight", ms: 150 });
    assert.equal(before.selectionStart, 0);
    assert.ok(result.after.selectionStart > before.selectionStart);
    assert.equal(result.after.selectionStart, result.after.selectionEnd);
    assert.equal(result.after.text, before.text);
    released(result.after);
    return { before, ...result };
  });

  await check("drag creates actual text selection", async () => {
    await fill(
      "abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789",
    );
    await dispatch("key", { key: "Control+Home" });
    const before = await state();
    const observed = await adapter!.observe();
    const requested = action(observed, "drag", {
      x: before.editFrame.x + 6 - observed.frame.x,
      y: before.editFrame.y + 10 - observed.frame.y,
      dx: before.editFrame.x + 190 - observed.frame.x,
      dy: before.editFrame.y + 10 - observed.frame.y,
    });
    const receipt = await adapter!.execute(requested);
    acknowledged(receipt, requested);
    await delay(50);
    const after = await state();
    assert.ok(after.selectionEnd > after.selectionStart);
    assert.equal(after.text, before.text);
    released(after);
    return { before, after, requested, receipt };
  });

  await check("scroll advances visible lines", async () => {
    const text = Array.from({ length: 80 }, (_, i) => `Line ${i} text`).join(
      "\r\n",
    );
    await fill(text);
    await dispatch("key", { key: "Control+Home" });
    const before = await state();
    const result = await dispatch("scroll", { amount: -360 });
    assert.ok(result.after.firstVisibleLine > before.firstVisibleLine);
    assert.ok(result.after.scrollPosition > before.scrollPosition);
    assert.equal(result.after.text, before.text);
    released(result.after);
    return { before, ...result };
  });

  await check("stale content rejects without further effect", async () => {
    const observed = await adapter!.observe();
    const mutation = action(observed, "fill", {
      locator: "101",
      value: "Changed content " + randomUUID(),
    });
    const mutationReceipt = await adapter!.execute(mutation);
    acknowledged(mutationReceipt, mutation);
    const before = await state();
    assert.equal(before.text, mutation.args.value);
    const requested = action(observed, "type", { text: "MUST NOT APPEAR" });
    const rejection = await adapter!.execute(requested);
    assert.equal(rejection.phase, "rejected");
    assert.equal(rejection.actionId, requested.id);
    assert.equal(rejection.runId, requested.runId);
    assert.match(rejection.detail, /content changed after observation/);
    const after = await state();
    assert.equal(after.text, before.text);
    released(after);
    return { before, after, mutation, mutationReceipt, requested, rejection };
  });

  await check(
    "foreign focus rejects without editing either window",
    async () => {
      const observed = await adapter!.observe();
      const before = await state();
      const foreignBefore = await state(otherHandle);
      const focused = await probe!.call("focus", { handle: otherHandle });
      assert.equal(focused.focused, true);
      const requested = action(observed, "type", { text: "MUST NOT APPEAR" });
      const rejection = await adapter!.execute(requested);
      assert.equal(rejection.phase, "rejected");
      assert.equal(rejection.actionId, requested.id);
      assert.equal(rejection.runId, requested.runId);
      assert.match(rejection.detail, /focus\/frame changed/);
      const after = await state();
      const foreignAfter = await state(otherHandle);
      assert.equal(after.text, before.text);
      assert.equal(foreignAfter.text, foreignBefore.text);
      released(after);
      await adapter!.focus();
      await delay(500);
      return {
        before,
        after,
        foreignBefore,
        foreignAfter,
        requested,
        rejection,
      };
    },
  );

  await check(
    "two live monitors preserve local coordinates and reject stale old frames",
    async () => {
      const inventory = await monitorProbe({ operation: "inventory" });
      report.physicalMonitors = inventory.screens;
      assert.ok(inventory.screens.length >= 2, "Two live monitors required");
      const selected = [...inventory.screens]
        .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
        .slice(0, 2);
      const owner = { handle, pid: fixtures[0].pid };
      const initial = await monitorProbe({ operation: "probe", ...owner });
      const transfers: Record<string, unknown>[] = [];
      try {
        await fill("abcdefghijklmnopqrstuvwxyz 0123456789");
        for (const monitor of selected) {
          await dispatch("key", { key: "Control+End" });
          const stale = await adapter!.observe();
          const beforeMove = await monitorProbe({
            operation: "probe",
            ...owner,
          });
          const moved = await monitorProbe({
            operation: "move",
            ...owner,
            x: monitor.working.x + 140,
            y: monitor.working.y + 100,
            width: Math.min(800, monitor.working.width - 280),
            height: Math.min(620, monitor.working.height - 200),
          });
          await delay(250);
          await adapter!.focus();
          const independentBefore = await state();
          const cursorBefore = await monitorProbe({
            operation: "probe",
            ...owner,
          });
          const staleAction = action(stale, "click", { x: 36, y: 92 });
          const rejection = await adapter!.execute(staleAction);
          assert.equal(rejection.phase, "rejected");
          assert.equal(rejection.actionId, staleAction.id);
          assert.equal(rejection.runId, staleAction.runId);
          assert.match(rejection.detail, /frame changed/);
          const independentAfterReject = await state();
          const cursorAfterReject = await monitorProbe({
            operation: "probe",
            ...owner,
          });
          assert.equal(independentAfterReject.text, independentBefore.text);
          assert.equal(
            independentAfterReject.selectionStart,
            independentBefore.selectionStart,
          );
          assert.equal(
            independentAfterReject.selectionEnd,
            independentBefore.selectionEnd,
          );
          assert.deepEqual(cursorAfterReject.cursor, cursorBefore.cursor);
          const current = await adapter!.observe();
          const independentWindow = await monitorProbe({
            operation: "probe",
            ...owner,
          });
          assert.equal(independentWindow.monitor, monitor.device);
          assert.deepEqual(
            {
              x: current.frame.x,
              y: current.frame.y,
              width: current.frame.width,
              height: current.frame.height,
            },
            independentWindow.frame,
          );
          assert.equal(current.frame.scale, independentWindow.dpi / 96);
          const x = independentBefore.editFrame.x + 12 - current.frame.x;
          const y = independentBefore.editFrame.y + 10 - current.frame.y;
          const requested = action(current, "click", { x, y });
          const receipt = await adapter!.execute(requested);
          acknowledged(receipt, requested);
          await delay(50);
          const after = await state();
          const independentAfter = await monitorProbe({
            operation: "probe",
            ...owner,
          });
          const expectedCursor = {
            x: current.frame.x + x,
            y: current.frame.y + y,
          };
          assert.deepEqual(after.cursor, expectedCursor);
          assert.deepEqual(independentAfter.cursor, expectedCursor);
          assert.equal(after.focusedHandle, after.editHandle);
          assert.ok(after.selectionStart < independentBefore.selectionStart);
          assert.equal(after.selectionStart, after.selectionEnd);
          released(after);
          await saveImage(`monitor-${transfers.length + 1}.png`);
          transfers.push({
            monitor,
            beforeMove,
            moved,
            independentWindow,
            staleAction,
            rejection,
            independentBefore,
            independentAfterReject,
            cursorBefore,
            cursorAfterReject,
            requested,
            receipt,
            after,
            independentAfter,
          });
        }
      } finally {
        await monitorProbe({ operation: "move", ...owner, ...initial.frame });
        await delay(250);
        await adapter!.focus();
      }
      const dpis = transfers.map((item: any) => item.independentWindow.dpi);
      const equalDpi = new Set(dpis).size === 1;
      if (equalDpi)
        report.limits.push(
          "Both tested windows reported the same GetDpiForWindow value. This run does not prove transfer between different physical display scales.",
        );
      return {
        inventory,
        transfers,
        dpis,
        equalDpi,
        restored: await monitorProbe({ operation: "probe", ...owner }),
      };
    },
  );

  await adapter.release(runId);
  generation = 0;
  await check(
    "cancellation waits for held-key cleanup and prevents next effect",
    async () => {
      runtime = new Runtime(store!, adapter!);
      const method = "native.effects.cancel";
      runtime.registry.put(
        seal({
          ...seedForm(),
          id: method,
          compatibility: [adapter!.identity],
          inputs: {},
          outputs: ["text"],
          capabilities: ["hold", "type"],
          preconditions: [],
          machine: {
            initial: "edit",
            states: [
              {
                id: "edit",
                monitor: ["focused"],
                steps: [
                  {
                    id: "held-right",
                    operation: "hold",
                    args: { key: "ArrowRight", ms: 250 },
                    scope: "edit",
                  },
                  {
                    id: "forbidden-after-cancel",
                    operation: "type",
                    args: { text: "MUST NOT APPEAR" },
                    scope: "edit",
                  },
                ],
              },
            ],
          },
        }),
      );
      const task = structuredTask(
        "Test cancellation in owned disposable editor",
        {
          host: adapter!.host,
          session: adapter!.session,
          identity: adapter!.identity,
        },
        {},
        method,
      );
      task.expected = { text: "MUST NOT APPEAR" };
      task.budgets.deadlineMs = 15000;
      runtime.submit(task, task.id);
      const before = await state();
      const execution = runtime.execute(task.id);
      let during: any;
      const deadline = Date.now() + 10000;
      do {
        during = await state();
        if (during.held.right) break;
        if (
          ["succeeded", "blocked", "reconciliation_required"].includes(
            store!.run(task.id).status,
          )
        )
          break;
        await delay(5);
      } while (Date.now() < deadline);
      assert.equal(
        during.held.right,
        true,
        "Independent probe must see the in-flight held key",
      );
      const cancelStarted = performance.now();
      const cancelled = await runtime.control(task.id, "cancel");
      const cancelMs = performance.now() - cancelStarted;
      await execution;
      const after = await state();
      const events = store!.events(0, task.id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(
        events.filter((event) => event.type === "dispatched").length,
        1,
      );
      assert.equal(after.text, before.text);
      released(after);
      return { before, during, after, cancelMs, run: cancelled, events };
    },
  );
  await saveImage("after.png");
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.reason = String(error);
  process.exitCode = 1;
} finally {
  try {
    if (generation) await adapter?.release(runId);
    if (handle && probe) {
      report.finalIndependentState = await state();
      released(report.finalIndependentState);
    }
    if (runtime) await runtime.close();
    else {
      await adapter?.close();
      store?.close();
    }
    await probe?.close();
  } catch (error) {
    report.cleanupError = String(error);
    report.status = "FAIL";
    process.exitCode = 1;
  } finally {
    monitorWorker?.stdin?.end();
    monitorWorker?.kill();
    for (const fixture of fixtures) fixture.kill();
    try {
      report.sourceAfter = fingerprint();
      report.executionFilesAfter = identities();
      report.sourceUnchanged =
        report.sourceBefore?.sha256 === report.sourceAfter.sha256 &&
        report.sourceBefore?.head === report.sourceAfter.head &&
        JSON.stringify(report.executionFilesBefore) ===
          JSON.stringify(report.executionFilesAfter);
    } catch (error) {
      report.sourceUnchanged = false;
      report.sourceIdentityError = String(error);
    }
    report.sourceStable = report.sourceUnchanged;
    if (!report.sourceUnchanged) {
      report.status = "FAIL";
      report.sourceFreshnessError =
        "Reviewed source or executable changed during evaluation";
      process.exitCode = 1;
    }
    report.finishedAt = new Date().toISOString();
    writeFileSync(
      join(directory, "results.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify({
        status: report.status,
        reason: report.reason,
        checks: report.checks.length,
        evidence: directory,
      }),
    );
  }
}
