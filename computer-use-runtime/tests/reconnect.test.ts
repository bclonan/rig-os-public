import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeClient } from "../src/sdk/index.js";
import { Store } from "../src/storage/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { seedForm } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
test("event client reconnects after a broken connection without replaying delivered events", async () => {
  const cursors: number[] = [];
  const server = createServer((req, res) => {
    const cursor = Number(
      new URL(req.url!, "http://localhost").searchParams.get("after"),
    );
    cursors.push(cursor);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      "data: " +
        JSON.stringify({
          schemaVersion: 1,
          seq: cursor + 1,
          runId: "test",
          correlationId: "test",
          at: Date.now(),
          type: "tick",
          data: {},
        }) +
        "\n\n",
    );
    setTimeout(() => res.destroy(), 20);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const client = new RuntimeClient(
      "http://127.0.0.1:" + (server.address() as any).port,
      "test",
    ),
    abort = new AbortController(),
    seen: number[] = [];
  try {
    for await (const event of client.events(0, abort.signal)) {
      seen.push(event.seq);
      if (seen.length === 3) {
        abort.abort();
        break;
      }
    }
    assert.deepEqual(seen, [1, 2, 3]);
    assert.deepEqual(cursors, [0, 1, 2]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("the coordinator serializes concurrent submissions on its environment", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-queue-"))),
    adapter = await new BrowserAdapter(store).start(),
    runtime = new Runtime(store, adapter);
  try {
    runtime.registry.put(seedForm());
    const tasks = ["Queued Alder", "Queued Birch"].map((name) =>
      structuredTask(
        "Set name",
        {
          host: adapter.host,
          session: adapter.session,
          identity: adapter.identity,
        },
        { name },
      ),
    );
    for (const task of tasks) runtime.submit(task, task.id);
    await Promise.all(tasks.map((t) => runtime.execute(t.id)));
    assert.deepEqual(
      tasks.map((t) => store.run(t.id).status),
      ["succeeded", "succeeded"],
    );
    const events = store.events();
    assert.ok(
      events.find((e) => e.runId === tasks[0].id && e.type === "completed")!
        .seq <
        events.find((e) => e.runId === tasks[1].id && e.type === "started")!
          .seq,
    );
  } finally {
    await runtime.close();
  }
});
