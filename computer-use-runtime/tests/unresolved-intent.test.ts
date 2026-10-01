import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { structuredTask } from "../src/compiler/intent.js";
import { service } from "../src/service/index.js";

test("public submission awaits unresolved requirement origins even with an empty summary", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-unresolved-")));
  const adapter = await new BrowserAdapter(store).start();
  const runtime = new Runtime(store, adapter);
  const app = await service(runtime);
  try {
    const observation = await adapter.observe();
    const task = structuredTask(
      "Set the display name after the user chooses it",
      {
        host: observation.host,
        session: observation.session,
        identity: observation.target,
      },
      { name: "Guessed name" },
    );
    task.requirements.push({
      name: "display_name_choice",
      value: "The user has not chosen the display name",
      origin: "unresolved",
    });
    const options = {
      method: "POST" as const,
      url: "/api/tasks",
      headers: {
        authorization: "Bearer " + store.token(),
        "idempotency-key": task.id,
        "x-correlation-id": task.correlationId,
      },
      payload: task,
    };
    const first = await app.inject(options);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().status, "awaiting_input");
    await runtime.execute(task.id);
    const repeated = await app.inject(options);
    assert.equal(repeated.statusCode, 200);
    assert.equal(repeated.json().id, task.id);
    assert.equal(store.runs().length, 1);
    assert.equal(
      store.events(0, task.id).filter((event) => event.type === "requested")
        .length,
      0,
    );
    assert.deepEqual(store.run(task.id).contract, task);
    assert.equal(
      (await adapter.observe()).facts.result,
      observation.facts.result,
    );
    await assert.rejects(
      () => runtime.control(task.id, "resume"),
      /Only a paused run/,
    );
    task.requirements[1].origin = "user_explicit";
    assert.equal(
      store.run(task.id).contract.requirements[1].origin,
      "unresolved",
    );
  } finally {
    await app.close();
    await runtime.close();
  }
});
