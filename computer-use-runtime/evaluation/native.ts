import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { Store } from "../src/storage/index.js";
import { NativeClient, WindowsAdapter } from "../src/adapters/native.js";
import { Runtime } from "../src/runtime/index.js";
import { seal, seedForm } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import type { Action } from "../src/contracts/index.js";
const evidenceDirectory = process.env.CUR_NATIVE_EVIDENCE || "evidence/native";
mkdirSync(evidenceDirectory, { recursive: true });
const results: any = {
  at: new Date().toISOString(),
  level: "native desktop",
  operations: [],
  status: "NOT RUN",
};
if (process.platform !== "win32") {
  results.status = "BLOCKED";
  results.reason = "Windows interactive host unavailable";
  writeFileSync(
    resolve(evidenceDirectory, "results.json"),
    JSON.stringify(results, null, 2),
  );
  process.exit(2);
}
const attach = process.argv.includes("--attach");
const fixture = attach
  ? undefined
  : spawn(resolve("native/target/release/disposable-editor.exe"), [], {
      windowsHide: false,
      stdio: "ignore",
    });
const probe = new NativeClient();
let adapter: WindowsAdapter | undefined;
let runtime: Runtime | undefined;
try {
  await new Promise((r) => setTimeout(r, 1000));
  const caps = await probe.call("capabilities");
  results.host = caps;
  const windows = await probe.call("windows");
  const matches = windows.filter(
    (w: any) =>
      (attach || w.pid === fixture?.pid) &&
      w.title === "Computer use disposable editor",
  );
  if (matches.length !== 1)
    throw new Error("Disposable application did not expose exactly one window");
  const handle = matches[0].handle;
  results.window = matches[0];
  await probe.close();
  const store = new Store(".data/native-" + Date.now());
  adapter = await new WindowsAdapter(store, false).start(handle);
  await adapter.client.call("focus", { handle });
  const before = await adapter.observe();
  writeFileSync(
    resolve(evidenceDirectory, "before.png"),
    store.artifactRead(before.image!),
  );
  const unique = "Runtime native verification " + randomUUID();
  const task = structuredTask(
    "Type a unique string in the disposable native editor",
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    { name: unique },
    "native.type",
  );
  task.expected = { text: unique };
  task.budgets.deadlineMs = 30000;
  const skill = seal({
    ...seedForm(),
    id: "native.type",
    compatibility: [adapter.identity],
    description:
      "Click the verified disposable editor and type the requested text",
    capabilities: ["click", "key", "type"],
    preconditions: [],
    machine: {
      initial: "edit",
      states: [
        {
          id: "edit",
          steps: [
            {
              id: "focus-edit",
              operation: "click",
              args: { x: 100, y: 120 },
              scope: "edit",
            },
            {
              id: "home",
              operation: "key",
              args: { key: "Control+Home" },
              scope: "edit",
            },
            {
              id: "select-old",
              operation: "key",
              args: { key: "Control+Shift+End" },
              scope: "edit",
            },
            {
              id: "type",
              operation: "type",
              args: { text: "$name" },
              scope: "edit",
            },
          ],
          monitor: ["focused"],
        },
      ],
    },
  });
  runtime = new Runtime(store, adapter);
  runtime.registry.put(skill);
  runtime.submit(task, task.id);
  await runtime.execute(task.id);
  const run = store.run(task.id);
  results.run = run;
  results.events = store.events(0, run.id);
  if (run.status !== "succeeded") throw new Error(run.error || run.status);
  results.operations.push({
    operation: "type",
    status: "PASS",
    independentText: (await adapter.client.call("fixture_text", { handle }))
      .text,
  });
  const generation = await adapter.acquire("direct-smoke");
  const operations: [string, Record<string, string | number | boolean>][] = [
    ["click", { x: 120, y: 150 }],
    ["drag", { x: 120, y: 160, dx: 240, dy: 180 }],
    ["scroll", { amount: -120 }],
    ["key", { key: "Control+A" }],
    ["hold", { key: "ArrowRight", ms: 100 }],
  ];
  for (const [operation, args] of operations) {
    const o = await adapter.observe();
    const a = {
      schemaVersion: 1 as const,
      id: randomUUID(),
      runId: "direct-smoke",
      requester: "local-user",
      host: adapter.host,
      session: adapter.session,
      target: adapter.identity,
      observationId: o.id,
      revision: o.revision,
      frame: o.frame,
      operation,
      args,
      deadline: Date.now() + 5000,
      scope: "edit",
      generation,
    };
    const receipt = await adapter.execute(a as Action);
    results.operations.push({ operation, status: "ACKNOWLEDGED", receipt });
  }
  const observed = await adapter.observe();
  const boundaryAction: Action = {
    schemaVersion: 1,
    id: randomUUID(),
    runId: "direct-smoke",
    requester: "local-user",
    host: adapter.host,
    session: adapter.session,
    target: adapter.identity,
    observationId: observed.id,
    revision: observed.revision,
    frame: observed.frame,
    operation: "click",
    args: { x: 120, y: 150 },
    deadline: Date.now() + 5000,
    scope: "edit",
    generation,
  };
  const frameRejected = await adapter.execute({
    ...boundaryAction,
    frame: { ...observed.frame, x: observed.frame.x + 10 },
  });
  assert.equal(frameRejected.phase, "rejected");
  assert.equal(frameRejected.actionId, boundaryAction.id);
  assert.equal(frameRejected.runId, boundaryAction.runId);
  assert.match(frameRejected.detail || "", /frame/i);
  await assert.rejects(
    () =>
      adapter!.execute({ ...boundaryAction, args: { x: 4294967296, y: 150 } }),
    /coordinate|point/i,
  );
  await assert.rejects(
    () => adapter!.execute({ ...boundaryAction, args: {} }),
    /coordinate|point/i,
  );
  results.boundaries =
    "PASS: changed frame, overflowing and missing coordinates rejected before input";
  const competitor = new NativeClient();
  try {
    await competitor.call("acquire", { runId: "competitor" });
    throw new Error("Competing process acquired same desktop");
  } catch (e) {
    if (String(e).includes("Competing process acquired")) throw e;
    results.ownership = "PASS: second process denied";
  } finally {
    await competitor.close();
  }
  await adapter.takeover();
  results.cleanup = await adapter.client.call("stop");
  const after = await adapter.observe();
  writeFileSync(
    resolve(evidenceDirectory, "after.png"),
    store.artifactRead(after.image!),
  );
  results.status = "PASS";
  results.limits =
    "Pointer/drag/scroll/hold dispatch and cleanup exercised. Semantic effects of each pointer operation are not independently established by this text fixture.";
} catch (e) {
  results.status = "FAIL";
  process.exitCode = 1;
  results.reason = String(e);
} finally {
  await runtime?.close();
  if (!runtime) await adapter?.close();
  fixture?.kill();
  writeFileSync(
    resolve(evidenceDirectory, "results.json"),
    JSON.stringify(results, null, 2),
  );
  console.log(
    JSON.stringify({
      status: results.status,
      reason: results.reason,
      operations: results.operations.length,
    }),
  );
}
