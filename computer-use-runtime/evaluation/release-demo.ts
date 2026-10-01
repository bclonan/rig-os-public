import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { AdaptiveSelector } from "../src/learner/selector.js";
import { seedForm } from "../src/skills/index.js";
import { service } from "../src/service/index.js";
import { RuntimeClient } from "../src/sdk/index.js";
import { structuredTask } from "../src/compiler/intent.js";
const store = new Store(mkdtempSync(join(tmpdir(), "cur-release-demo-")));
const adapter = await new BrowserAdapter(store).start();
const selector = new AdaptiveSelector(store);
const runtime = new Runtime(
  store,
  adapter,
  undefined,
  undefined,
  selector.select.bind(selector),
);
runtime.registry.put(seedForm());
const app = await service(runtime);
const client = new RuntimeClient(
  await app.listen({ host: "127.0.0.1", port: 0 }),
  store.token(),
);
const caps = await client.request("/api/capabilities");
const target = {
  host: caps.host,
  session: caps.session,
  identity: caps.identity,
};
const result: any = {
  status: "NOT RUN",
  level: "live standalone HTTP service",
  runs: [],
};
async function wait(id: string) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const run = await client.status(id);
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Demo deadline");
}
try {
  for (const name of [
    "Release Alder " + Date.now(),
    "Release Birch " + Date.now(),
    "Release Cedar " + Date.now(),
  ]) {
    const task = structuredTask("Set display name", target, { name });
    await client.submit(task);
    const run = await wait(task.id);
    if (run.status !== "succeeded") throw new Error(run.error || run.status);
    result.runs.push(run);
    const key = "record-" + task.id;
    const one = await client.request(
        "/api/record",
        "POST",
        { runId: run.id },
        key,
      ),
      two = await client.request("/api/record", "POST", { runId: run.id }, key);
    if (one.id !== two.id) throw new Error("Record request duplicated");
  }
  const draft = await client.request("/api/compile", "POST", {});
  result.published = await client.request(
    "/api/skills/" + draft.id + "/test",
    "POST",
    {},
  );
  result.model = await client.request("/api/models/activate", "POST", {
    id: "owned-17",
  });
  const task = structuredTask(
    "Set name through the audited owned controller",
    target,
    { name: "Owned model release check" },
    "auto",
  );
  await client.submit(task);
  result.learnedRun = await wait(task.id);
  if (result.learnedRun.status !== "succeeded")
    throw new Error("Activated model failed");
  result.rollback = await client.request("/api/models/rollback", "POST", {});
  const bundle = await client.request("/api/datasets/export");
  result.dataset = {
    demonstrations: bundle.demonstrations.length,
    images: Object.keys(bundle.artifacts).length,
    digest: bundle.digest,
  };
  result.status = "PASS";
} catch (e) {
  result.status = "FAIL";
  result.reason = String(e);
  process.exitCode = 1;
} finally {
  await selector.close();
  await app.close();
  writeFileSync(
    "evidence/review-release-demo.json",
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      status: result.status,
      reason: result.reason,
      published: result.published?.id,
      model: result.model?.id,
      dataset: result.dataset,
    }),
  );
}
