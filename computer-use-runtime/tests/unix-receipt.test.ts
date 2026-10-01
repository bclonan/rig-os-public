import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/index.js";
import { UnixAdapter } from "../src/adapters/unix.js";
import type { NativeClient } from "../src/adapters/native.js";
import type { Action } from "../src/contracts/index.js";

test("Unix delivered and rejected receipts must bind exact action and run", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-unix-receipt-")));
  let result: any;
  const adapter = new UnixAdapter(store, "linux", {
    async call() {
      return result;
    },
    async close() {},
  } as unknown as NativeClient);
  const action: Action = {
    schemaVersion: 1,
    id: "action",
    runId: "run",
    requester: "user",
    host: "host",
    session: "session",
    target: "1",
    observationId: "obs",
    revision: "revision",
    frame: { x: 0, y: 0, width: 100, height: 100, scale: 1 },
    operation: "click",
    args: { x: 10, y: 10 },
    deadline: Date.now() + 1000,
    scope: "edit",
    generation: 1,
  };
  try {
    for (const malformed of [
      { backend: "native", delivered: true },
      {
        backend: "native",
        delivered: false,
        actionId: action.id,
        runId: action.runId,
      },
      {
        backend: "native",
        delivered: true,
        actionId: "foreign",
        runId: action.runId,
      },
      {
        backend: "native",
        phase: "rejected",
        actionId: action.id,
        runId: action.runId,
        dispatched: true,
        reason: "late",
      },
    ]) {
      result = malformed;
      await assert.rejects(
        () => adapter.execute(action),
        /bind|delivery|confirm|Malformed/,
      );
    }
    result = {
      backend: "native",
      actionId: action.id,
      runId: action.runId,
      phase: "rejected",
      dispatched: false,
      reason: "Stale controls",
    };
    assert.equal((await adapter.execute(action)).phase, "rejected");
    result = {
      backend: "native",
      actionId: action.id,
      runId: action.runId,
      delivered: true,
    };
    assert.equal((await adapter.execute(action)).phase, "acknowledged");
  } finally {
    await adapter.close();
    store.close();
  }
});
