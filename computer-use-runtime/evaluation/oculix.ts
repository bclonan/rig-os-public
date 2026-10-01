import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { OculixBackend, OCULIX_COMMIT } from "../src/adapters/oculix.js";
import { NativeClient, WindowsAdapter } from "../src/adapters/native.js";
import { structuredTask } from "../src/compiler/intent.js";
import type { Action } from "../src/contracts/index.js";
import { trainingPython } from "../src/learner/python.js";
import { screenshotTensor } from "../src/learner/image.js";
import { Runtime } from "../src/runtime/index.js";
import { seal, seedForm } from "../src/skills/index.js";
import { hash, Store } from "../src/storage/index.js";

const fingerprint = () =>
  JSON.parse(
    execFileSync(trainingPython(), ["scripts/source-identity.py"], {
      encoding: "utf8",
    }),
  );

/** Pinned Oculix captures pixels. Its unbound input tools must remain disabled. */
export async function checkCaptureOnlyBoundary(backend: OculixBackend) {
  assert.deepEqual(backend.capabilities(), ["observe"]);
  for (const operation of ["click", "key", "type", "scroll"] as const)
    await assert.rejects(
      () => backend.execute(operation, {}),
      /cannot bind a target and lease at dispatch/,
    );
  return {
    status: "PASS",
    capabilities: backend.capabilities(),
    rejectedInputs: ["click", "key", "type", "scroll"],
  };
}

export async function evaluateOculix(directory: string) {
  mkdirSync(directory, { recursive: true });
  const report: Record<string, any> = {
    schemaVersion: 2,
    startedAt: new Date().toISOString(),
    status: "NOT RUN",
    evidenceLevel: "pinned Oculix capture and real guarded Win32 fixture input",
    checks: [],
    limits: [
      "Oculix input is disabled because its tools cannot bind the target and lease at dispatch.",
      "Input effects are limited to a disposable editor created by this evaluator.",
      "Oculix capture is supplemental. Runtime authority and coherent observations remain with the native adapter.",
    ],
  };
  let fixture: ChildProcess | undefined;
  let probe: NativeClient | undefined;
  let backend: OculixBackend | undefined;
  let runtime: Runtime | undefined;
  let adapter: WindowsAdapter | undefined;
  let store: Store | undefined;
  try {
    assert.equal(
      process.platform,
      "win32",
      "Windows interactive host is required",
    );
    report.sourceBefore = fingerprint();
    const jdk = readdirSync(".tools").find((entry) => entry.startsWith("jdk-"));
    assert.ok(jdk, "Pinned local JDK is required");
    const java = resolve(".tools", jdk, "bin/java.exe");
    const jar = resolve(".research/Oculix/MCP/target/oculix-mcp-server.jar");
    const fixtureExecutable = resolve(
      "native/target/release/disposable-editor.exe",
    );
    const binaryPaths = [
      java,
      jar,
      fixtureExecutable,
      resolve("native/target/release/computer-use-native.exe"),
    ];
    const binaryHashes = () =>
      Object.fromEntries(
        binaryPaths.map((path) => [path, hash(readFileSync(path))]),
      );
    report.binaryHashesBefore = binaryHashes();
    store = new Store(mkdtempSync(join(tmpdir(), "cur-oculix-")));
    report.store = store.root;
    probe = new NativeClient();
    fixture = spawn(fixtureExecutable, [], {
      windowsHide: false,
      stdio: "ignore",
    });
    fixture.on("error", (error) => {
      report.fixtureError = String(error);
    });
    const fixturePid = fixture.pid || 0;
    assert.ok(fixturePid, "Owned fixture must have a PID");
    let matches: any[] = [];
    const startupDeadline = Date.now() + 6000;
    do {
      matches = (await probe.call("windows")).filter(
        (window: any) =>
          window.pid === fixturePid &&
          window.title === "Computer use disposable editor",
      );
      if (matches.length === 1) break;
      await delay(100);
    } while (Date.now() < startupDeadline);
    assert.equal(
      matches.length,
      1,
      "Exactly one owned fixture window is required",
    );
    const window = matches[0];
    assert.equal(
      resolve(window.executable).toLowerCase(),
      fixtureExecutable.toLowerCase(),
    );
    report.ownedWindow = window;

    adapter = await new WindowsAdapter(store, true).start(window.handle);
    await adapter.focus();
    await delay(250);
    const preference = store.get<any>("backend", "oculix");
    assert.equal(
      preference?.commit,
      OCULIX_COMMIT,
      "Preference must discover the actual pinned backend",
    );
    assert.equal(preference?.jarSha256, report.binaryHashesBefore[jar]);
    report.preference = {
      commit: preference.commit,
      jarSha256: preference.jarSha256,
      toolNames: preference.tools.map((tool: any) => tool.name),
    };
    assert.ok(report.preference.toolNames.includes("oculix_screenshot"));
    backend = new OculixBackend();
    const listing = await backend.start(java, jar);
    assert.equal(listing.jarSha256, preference.jarSha256);
    const initialText = (
      await probe.call("fixture_text", { handle: window.handle })
    ).text;
    report.checks.push({
      name: "capture-only capability boundary",
      ...(await checkCaptureOnlyBoundary(backend)),
    });
    assert.equal(
      (await probe.call("fixture_text", { handle: window.handle })).text,
      initialText,
      "Rejected Oculix input must leave the fixture unchanged",
    );
    const before = await adapter.observe();
    assert.equal(
      before.facts.captureStatus,
      "preferred-full-rgb-confirmed",
      "The actual adapter observation must prefer validated Oculix capture",
    );
    assert.equal(before.facts.captureBackend, "oculix-mcp:" + OCULIX_COMMIT);
    assert.ok(before.image);
    const bytes = store.artifactRead(before.image);
    assert.equal(hash(bytes), before.facts.captureImageSha256);
    const captureProvenance = store.get<any>("backend", "last-capture");
    assert.equal(captureProvenance.observationId, before.id);
    assert.equal(captureProvenance.nativeRevision, before.revision);
    assert.equal(captureProvenance.imageSha256, before.image);
    assert.equal(captureProvenance.captureBackend, before.facts.captureBackend);
    assert.equal(screenshotTensor(bytes).length, 3072);
    writeFileSync(join(directory, "oculix-capture.png"), bytes);
    report.checks.push({
      name: "actual preferred adapter Oculix capture with complete native RGB confirmation",
      status: "PASS",
      backend: before.facts.captureBackend,
      observation: before,
      provenance: captureProvenance,
      imageSha256: hash(bytes),
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    });

    runtime = new Runtime(store, adapter);
    const skill = seal({
      ...seedForm(),
      id: "oculix.guarded-fixture-replace",
      description:
        "Replace the text in this evaluator's owned disposable editor",
      inputs: { x: "number", y: "number", text: "string" },
      outputs: ["text"],
      capabilities: ["click", "key", "type"],
      preconditions: ["focused"],
      compatibility: [adapter.identity],
      machine: {
        initial: "replace",
        states: [
          {
            id: "replace",
            monitor: ["focused"],
            steps: [
              {
                id: "focus-editor",
                operation: "click",
                scope: "edit",
                args: { x: "$x", y: "$y" },
              },
              {
                id: "select-text",
                operation: "key",
                scope: "edit",
                args: { key: "Control+A" },
              },
              {
                id: "replace-text",
                operation: "type",
                scope: "edit",
                args: { text: "$text" },
              },
            ],
          },
        ],
      },
    });
    runtime.registry.put(skill);
    const independent = await probe.call("fixture_state", {
      handle: window.handle,
    });
    const text = "Guarded Oculix fallback " + randomUUID();
    const task = structuredTask(
      "Replace text in the owned disposable editor",
      {
        host: adapter.host,
        session: adapter.session,
        identity: adapter.identity,
      },
      {
        text,
        x: independent.editFrame.x + 12 - before.frame.x,
        y: independent.editFrame.y + 10 - before.frame.y,
      },
      skill.id,
    );
    task.expected = { text };
    task.requirements = [
      { name: "text", value: text, origin: "user_explicit" },
    ];
    runtime.submit(task, task.id);
    await runtime.execute(task.id);
    const run = store.run(task.id);
    const actual = await probe.call("fixture_state", { handle: window.handle });
    assert.equal(run.status, "succeeded", run.error || "Expected success");
    assert.equal(
      actual.text,
      text,
      "Independent Win32 fixture text must equal the goal",
    );
    assert.ok(Object.values(actual.held).every((pressed) => pressed === false));
    const events = store.events(0, task.id);
    const receipts = events
      .filter((event) => event.type === "acknowledged")
      .map((event) => event.data as any);
    assert.equal(receipts.length, 3);
    assert.ok(
      receipts.every(
        (receipt) =>
          receipt.phase === "acknowledged" &&
          receipt.backend === "rust-win32-v1",
      ),
    );
    report.checks.push({
      name: "preferred Oculix falls back to guarded native input",
      status: "PASS",
      runId: run.id,
      actual,
      receipts,
      verification: events.filter((event) => event.type === "verification"),
    });

    const requested = events.find((event) => event.type === "requested")!
      .data as Action;
    const fresh = await adapter.observe();
    const unowned = {
      ...requested,
      id: randomUUID(),
      runId: "unowned-" + randomUUID(),
      observationId: fresh.id,
      revision: fresh.revision,
      frame: fresh.frame,
      generation: requested.generation + 1,
      deadline: Date.now() + 10000,
    };
    const rejection = await adapter.execute(unowned);
    assert.equal(
      rejection.phase,
      "rejected",
      "A fresh observation without an owned lease must not dispatch",
    );
    assert.equal(
      (await probe.call("fixture_text", { handle: window.handle })).text,
      text,
    );
    report.checks.push({
      name: "native fallback still rejects an unowned lease",
      status: "PASS",
      receipt: rejection,
    });
    report.binaryHashesAfter = binaryHashes();
    assert.deepEqual(
      report.binaryHashesAfter,
      report.binaryHashesBefore,
      "Test binaries changed while testing",
    );
    report.sourceAfter = fingerprint();
    report.sourceStable =
      report.sourceAfter.sha256 === report.sourceBefore.sha256;
    report.status = report.sourceStable ? "PASS" : "SOURCE CHANGED";
    report.completedAt = new Date().toISOString();
  } catch (error) {
    report.status = "FAIL";
    report.reason = String(error);
  } finally {
    await backend?.close().catch((error) => {
      report.oculixCleanupError = String(error);
    });
    if (runtime)
      await runtime.close().catch((error) => {
        report.runtimeCleanupError = String(error);
      });
    else {
      await adapter?.close().catch((error) => {
        report.runtimeCleanupError = String(error);
      });
      store?.close();
    }
    await probe?.close().catch((error) => {
      report.probeCleanupError = String(error);
    });
    if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
      await new Promise<void>((resolveClosed) => {
        const timeout = setTimeout(() => {
          report.fixtureCleanupError =
            "Owned fixture did not close within 5000ms";
          resolveClosed();
        }, 5000);
        fixture!.once("close", () => {
          clearTimeout(timeout);
          resolveClosed();
        });
        fixture!.kill();
      });
    }
    if (
      report.oculixCleanupError ||
      report.runtimeCleanupError ||
      report.probeCleanupError ||
      report.fixtureCleanupError
    )
      report.status = "FAIL";
    writeFileSync(
      join(directory, "results.json"),
      JSON.stringify(report, null, 2),
    );
  }
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const directory = resolve(
    "evidence/oculix",
    new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID(),
  );
  const report = await evaluateOculix(directory);
  console.log(
    JSON.stringify({
      status: report.status,
      reason: report.reason,
      checks: report.checks.length,
      directory,
    }),
  );
  if (report.status !== "PASS") process.exitCode = 1;
}
