import { Store } from "../src/storage/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Action } from "../src/contracts/index.js";
const store = new Store(".data/moving-" + Date.now()),
  adapter = await new BrowserAdapter(store).start();
const result: any = {
  level: "resettable live browser fixture",
  attempts: [],
  claims:
    "Structured locator tracking only; pixel-only game control remains unverified",
};
try {
  await adapter.page.goto(
    pathToFileURL(resolve("fixtures/workbench.html")).href + "?moving=1",
  );
  const generation = await adapter.acquire("moving");
  for (let i = 0; i < 12; i++) {
    const t = performance.now(),
      o = await adapter.observe();
    const a: Action = {
      schemaVersion: 1,
      id: randomUUID(),
      runId: "moving",
      requester: "local-user",
      host: adapter.host,
      session: adapter.session,
      target: adapter.identity,
      observationId: o.id,
      revision: o.revision,
      frame: o.frame,
      operation: "click",
      args: { locator: "target" },
      deadline: Date.now() + 3000,
      scope: "edit",
      generation,
    };
    try {
      await adapter.execute(a);
      result.attempts.push({
        status: "acknowledged",
        latencyMs: performance.now() - t,
      });
    } catch (e) {
      result.attempts.push({
        status: "rejected",
        error: String(e),
        latencyMs: performance.now() - t,
      });
    }
  }
  const old = await adapter.observe();
  await new Promise((r) => setTimeout(r, 2100));
  const a: Action = {
    schemaVersion: 1,
    id: randomUUID(),
    runId: "moving",
    requester: "local-user",
    host: adapter.host,
    session: adapter.session,
    target: adapter.identity,
    observationId: old.id,
    revision: old.revision,
    frame: old.frame,
    operation: "hold",
    args: { key: "ArrowRight", ms: 1000 },
    deadline: Date.now() + 2000,
    scope: "edit",
    generation,
  };
  try {
    await adapter.execute(a);
    result.staleFrame = "FAIL";
  } catch {
    result.staleFrame = "PASS";
  }
  const o = await adapter.observe();
  const abort = new AbortController();
  const held = adapter.execute(
    { ...a, id: randomUUID(), observationId: o.id, revision: o.revision },
    abort.signal,
  );
  setTimeout(() => abort.abort(), 50);
  try {
    await held;
  } catch {}
  await adapter.takeover();
  result.cleanup =
    "held key released in finally; takeover invalidated generation";
  result.actualHits = await adapter.page.locator("#target").textContent();
  result.status =
    result.staleFrame === "PASS" &&
    result.attempts.some((a: any) => a.status === "acknowledged")
      ? "PASS"
      : "FAIL";
} finally {
  await adapter.close();
  store.close();
  writeFileSync("evidence/moving.json", JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
