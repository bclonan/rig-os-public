import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { service } from "../src/service/index.js";

test(
  "job shutdown terminates its real child and persists cancellation; URL aliases deduplicate",
  { timeout: 15000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cur-job-process-"));
    const marker = join(root, "worker.pid");
    const store = new Store(root);
    const adapter = await new BrowserAdapter(store).start();
    const runtime = new Runtime(store, adapter);
    // A real long-running process makes cancellation deterministic without
    // requiring PyTorch. Real training has its separate live console evaluation.
    const app = await service(runtime, {
      trainingCommand: {
        executable: process.execPath,
        args: [
          "--input-type=module",
          "--eval",
          `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`,
        ],
      },
    });
    const headers = {
      host: "127.0.0.1",
      authorization: "Bearer " + store.token(),
      "idempotency-key": "same-job",
      "x-correlation-id": "test",
    };
    let id: string;
    let pid: number;
    try {
      const initial = await app.inject({
        method: "POST",
        url: "/api/jobs",
        headers,
        payload: { type: "train" },
      });
      assert.equal(initial.statusCode, 200);
      id = initial.json().id;
      for (const url of ["/%61pi/jobs", "/api/jobs?retry=1"]) {
        const duplicate = await app.inject({
          method: "POST",
          url,
          headers,
          payload: { type: "train" },
        });
        assert.equal(duplicate.statusCode, 200);
        assert.equal(duplicate.json().id, id);
      }
      assert.equal(store.list("jobs").length, 1);
      const deadline = Date.now() + 5000;
      while (!existsSync(marker)) {
        if (Date.now() >= deadline) throw new Error("Child did not start");
        await delay(25);
      }
      pid = Number(readFileSync(marker, "utf8"));
      assert.ok(pid > 0);
      process.kill(pid, 0);
    } finally {
      await app.close();
    }
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    const reopened = new Store(root);
    try {
      assert.equal(reopened.get<any>("jobs", id).status, "cancelled");
    } finally {
      reopened.close();
    }
  },
);
