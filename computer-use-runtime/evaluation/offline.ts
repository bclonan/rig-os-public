import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { seedForm } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { Controller } from "../src/learner/index.js";
const originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = async () => {
  requests++;
  throw new Error("Network forbidden in offline test");
};
const store = new Store(mkdtempSync(join(tmpdir(), "cur-offline-"))),
  adapter = await new BrowserAdapter(store).start(),
  runtime = new Runtime(store, adapter);
const result: any = {
  level: "resettable live fixture",
  networkBoundary:
    "Browser context offline, all Node fetch calls denied, no OS-wide network changes",
  status: "NOT RUN",
};
try {
  await adapter.page.context().setOffline(true);
  await adapter.reset("ready", "shift");
  runtime.registry.put(seedForm());
  const model = await Controller.load("models/17/trained.onnx");
  const prediction = await model.rank(await adapter.observe(), [seedForm()]);
  assert.equal(prediction.index, 0);
  await model.close();
  const t = structuredTask(
    "Offline form execution",
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    { name: "Offline Cedar 472" },
  );
  runtime.submit(t, t.id);
  await runtime.execute(t.id);
  assert.equal(store.run(t.id).status, "succeeded");
  result.status = "PASS";
  result.run = store.run(t.id);
  result.attemptedFetchCalls = requests;
  result.onnxInferenceMs = prediction.latencyMs;
} catch (e) {
  result.status = "FAIL";
  process.exitCode = 1;
  result.reason = String(e);
} finally {
  await runtime.close();
  globalThis.fetch = originalFetch;
  writeFileSync("evidence/offline.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
