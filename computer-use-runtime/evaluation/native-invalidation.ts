import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WindowsAdapter, NativeClient } from "../src/adapters/native.js";
import { Store } from "../src/storage/index.js";
import { fact, guardPass } from "../src/predicates/index.js";
import { ScopedEvidenceCache } from "../src/predicates/cache.js";
import type { Action } from "../src/contracts/index.js";

const directory = resolve(
  "evidence/completion/native-invalidation",
  Date.now() + "-" + randomUUID(),
);
mkdirSync(directory, { recursive: true });
const fingerprint = () =>
  JSON.parse(
    execFileSync("python", ["scripts/source-identity.py"], {
      encoding: "utf8",
    }),
  );
const binaries = () =>
  Object.fromEntries(
    ["computer-use-native.exe", "disposable-editor.exe"].map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(resolve("native/target/release", name)))
        .digest("hex"),
    ]),
  );
const report: any = {
  schemaVersion: 1,
  status: "FAIL",
  sourceBefore: fingerprint(),
  binariesBefore: binaries(),
  checks: [],
  limits: [
    "Actual Windows WinEvent and raw pixel dependencies only. Unix continues full observation.",
    "A cached assessment does not pass a fresh required guard or authorize input.",
    "Input still requires full coherent native capture and independent application verification.",
  ],
};
const fixture = spawn(
  resolve("native/target/release/disposable-editor.exe"),
  [],
  { windowsHide: false, stdio: "ignore" },
);
const store = new Store(
    mkdtempSync(join(tmpdir(), "cur-native-invalidation-")),
  ),
  adapter = new WindowsAdapter(store, false),
  probe = new NativeClient();
try {
  assert.equal(process.platform, "win32");
  let window: any;
  for (let attempt = 0; attempt < 50 && !window; attempt++) {
    await delay(100);
    window = (await probe.call("windows")).find(
      (entry: any) =>
        entry.pid === fixture.pid &&
        entry.title === "Computer use disposable editor",
    );
  }
  assert.ok(window, "An exact owned disposable fixture must exist");
  report.window = window;
  await adapter.start(window.handle);
  await adapter.focus();
  await delay(200);
  const generation = await adapter.acquire("native-invalidation");
  const before = await adapter.observe();
  assert.equal(before.facts.nativeEventsAvailable, true);
  const region = before.controls!.find(
    (control) => control.id === "101",
  )!.bounds;
  const cache = new ScopedEvidenceCache<ReturnType<typeof fact>>();
  const evidence = fact(before, "text", before.facts.text, "knowledge");
  cache.remember("text", evidence, before, ["text"], region);
  await delay(50);
  const unchanged = await adapter.observe();
  const reused = cache.get("text", unchanged);
  assert.ok(
    reused,
    "Unchanged source should reuse its recorded knowledge assessment",
  );
  assert.equal(
    guardPass(reused.value, unchanged),
    false,
    "Old cached evidence cannot pass a new required guard",
  );
  const value = "Event driven observed text " + randomUUID();
  const action: Action = {
    schemaVersion: 1,
    id: randomUUID(),
    runId: "native-invalidation",
    requester: "local-user",
    host: adapter.host,
    session: adapter.session,
    target: adapter.identity,
    observationId: unchanged.id,
    revision: unchanged.revision,
    frame: unchanged.frame,
    operation: "fill",
    args: { locator: "101", value },
    deadline: Date.now() + 5000,
    scope: "edit",
    generation,
  };
  const receipt = await adapter.execute(action);
  assert.equal(receipt.phase, "acknowledged");
  assert.equal(receipt.actionId, action.id);
  assert.equal(receipt.runId, action.runId);
  await delay(100);
  const independent = await probe.call("fixture_state", {
    handle: window.handle,
  });
  assert.equal(independent.text, value);
  const after = await adapter.observe();
  assert.equal(after.facts.text, value);
  assert.ok(
    Number(after.facts.nativeEventCount) > 0,
    "Actual scoped WinEvent must be delivered",
  );
  assert.notEqual(
    after.facts.changedRegion,
    "null",
    "Actual pixel changes must expose their region",
  );
  assert.equal(
    cache.get("text", after),
    undefined,
    "Value/event/pixel change must invalidate dependent evidence",
  );
  report.checks = [
    { name: "native event subscription", status: "PASS" },
    { name: "unchanged scoped knowledge reuse", status: "PASS" },
    { name: "fresh guard rejects old evidence", status: "PASS" },
    { name: "independent changed text", status: "PASS" },
    { name: "pixel region and native event invalidate", status: "PASS" },
  ];
  report.before = before;
  report.unchanged = unchanged;
  report.after = after;
  report.action = action;
  report.receipt = receipt;
  report.independent = independent;
  report.status = "PASS";
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await adapter.release("native-invalidation").catch((error) => {
    report.status = "FAIL";
    report.cleanupError = String(error);
    process.exitCode = 1;
  });
  await adapter.close();
  await probe.close();
  store.close();
  fixture.kill();
  report.sourceAfter = fingerprint();
  report.binariesAfter = binaries();
  report.binariesStable =
    JSON.stringify(report.binariesBefore) ===
    JSON.stringify(report.binariesAfter);
  report.sourceStable =
    JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter);
  if (!report.sourceStable || !report.binariesStable) {
    report.status = "FAIL";
    process.exitCode = 1;
  }
  writeFileSync(
    join(directory, "results.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      status: report.status,
      error: report.error,
      sourceStable: report.sourceStable,
      directory,
    }),
  );
}
