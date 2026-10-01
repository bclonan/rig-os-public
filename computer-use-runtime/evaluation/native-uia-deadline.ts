import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { NativeClient, NativeDeadlineError } from "../src/adapters/native.js";
import { hash } from "../src/storage/index.js";

assert.equal(process.platform, "win32", "This gate needs real Windows UIA");
const directory = resolve(
  "evidence/completion/native-uia-deadline",
  randomUUID(),
);
mkdirSync(directory, { recursive: true });
const arm = join(directory, "arm");
const fixturePath = resolve("fixtures/OwnedHungProvider.ps1");
const paths = [
  "src/adapters/native.ts",
  "native/src/accessibility.rs",
  "native/target/release/computer-use-native.exe",
  "fixtures/OwnedHungProvider.ps1",
  "evaluation/native-uia-deadline.ts",
];
const identities = () =>
  Object.fromEntries(paths.map((path) => [path, hash(readFileSync(path))]));
const sourceBefore = identities();
const report: Record<string, unknown> = {
  status: "RUNNING",
  scope:
    "Real Windows WPF AutomationPeer blocks GetNameCore for 30 seconds. Read-only accessibility call, no input or skill dispatch. COM cancellation is not claimed; the owned worker must settle by termination.",
  sourceBefore,
  directory,
};
const fixture = spawn(
  "powershell.exe",
  ["-NoProfile", "-STA", "-File", fixturePath, "-ArmPath", arm],
  { windowsHide: true, stdio: "pipe" },
);
let stderr = "",
  client: NativeClient | undefined;
fixture.stderr.on("data", (data) => {
  stderr += data.toString();
});
const fixtureClosed = new Promise<void>((resolveClosed) =>
  fixture.once("close", () => resolveClosed()),
);
try {
  const ready = await new Promise<{ pid: number; handle: number }>(
    (resolveReady, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Owned WPF startup deadline")),
        20000,
      );
      const lines = createInterface({ input: fixture.stdout });
      lines.on("line", (line) => {
        try {
          const value = JSON.parse(line);
          assert.equal(value.pid, fixture.pid);
          assert.ok(value.handle > 0);
          clearTimeout(timeout);
          resolveReady(value);
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
      fixture.once("exit", () => {
        clearTimeout(timeout);
        reject(new Error("Fixture exited: " + stderr));
      });
    },
  );
  report.fixture = ready;
  client = new NativeClient();
  const baseline = await client.call("accessibility", { handle: ready.handle });
  assert.ok(
    Array.isArray(baseline) &&
      baseline.some((element) => element.name === "Owned delayed UIA provider"),
  );
  writeFileSync(arm, "Explicitly arm only this owned provider");
  const started = performance.now();
  await assert.rejects(
    client.call("accessibility", { handle: ready.handle }, 500),
    NativeDeadlineError,
  );
  const elapsed = performance.now() - started;
  for (let i = 0; i < 100 && !existsSync(arm + ".entered"); i++)
    await delay(20);
  assert.ok(
    existsSync(arm + ".entered"),
    "Actual UIA must reach the blocked AutomationPeer",
  );
  assert.ok(
    elapsed >= 450 && elapsed < 1500,
    "Caller deadline must settle within bound",
  );
  report.deadline = {
    requestedMs: 500,
    elapsedMs: elapsed,
    actualProviderEnteredAt: readFileSync(arm + ".entered", "utf8"),
  };
  const closing = performance.now();
  await assert.rejects(client.close(), /deadline|forced|cleanup|release/i);
  assert.ok(performance.now() - closing < 4500);
  assert.ok(
    client.process.exitCode !== null || client.process.signalCode !== null,
  );
  report.cleanup = {
    workerPid: client.process.pid,
    settled: true,
    forced: true,
    cleanupConfirmed: false,
  };
  client = undefined;
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.error = String(error);
  process.exitCode = 1;
} finally {
  if (client) {
    try {
      await client.close();
    } catch (error) {
      report.workerCleanupError = String(error);
    }
  }
  if (fixture.exitCode === null && fixture.signalCode === null) fixture.kill();
  await fixtureClosed;
  report.fixtureSettled =
    fixture.exitCode !== null || fixture.signalCode !== null;
  report.fixtureStderr = stderr;
  report.sourceAfter = identities();
  assert.deepEqual(report.sourceAfter, sourceBefore);
  writeFileSync(
    join(directory, "results.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify({ status: report.status, directory }));
}
