import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeClient, WindowsAdapter } from "../src/adapters/native.js";
import { Store } from "../src/storage/index.js";

// These workers exercise the real process transport, without OS input.
const worker = String.raw`
const readline = require('node:readline');
const mode = process.argv[1];
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const response = request.method === 'stop' && mode === 'error'
    ? { id: request.id, error: 'Injected owned key-up failure' }
    : { id: request.id, result: request.method === 'stop'
      ? { heldInputsReleased: mode !== 'unconfirmed' } : { ready: true } };
  process.stdout.write(JSON.stringify(response) + '\n');
});
if (mode === 'hang') setInterval(() => {}, 1000);
`;

test("native close reports rejected cleanup, missing confirmation and forced worker death", async () => {
  for (const mode of ["error", "unconfirmed", "hang"]) {
    const client = new NativeClient(process.execPath, ["-e", worker, mode]);
    assert.equal((await client.call("ready")).ready, true);
    const closing = client.close();
    assert.equal(client.close(), closing);
    await assert.rejects(closing, /cleanup|release|forced|key-up/i);
    assert.ok(
      client.process.exitCode !== null || client.process.signalCode !== null,
    );
    await assert.rejects(() => client.call("ready"), /closed/);
  }
});

test("confirmed native cleanup closes its worker and remains idempotent", async () => {
  const client = new NativeClient(process.execPath, ["-e", worker, "normal"]);
  await client.call("ready");
  const closing = client.close();
  assert.equal(client.close(), closing);
  await closing;
  assert.equal(client.process.exitCode, 0);
});

test("capture cleanup failure cannot skip guarded worker cleanup", async () => {
  for (const operation of ["close", "takeover"] as const) {
    const store = new Store(mkdtempSync(join(tmpdir(), "cur-native-cleanup-")));
    const calls: string[] = [];
    const captureFailure = new Error("Capture cleanup refused");
    const workerFailure = new Error("Guarded cleanup refused");
    const guardedCleanup = async () => {
      calls.push("guarded-start");
      await new Promise((resolve) => setTimeout(resolve, 15));
      calls.push("guarded-settled");
      throw workerFailure;
    };
    const adapter = new WindowsAdapter(store, false, {
      close: guardedCleanup,
      call: guardedCleanup,
    } as unknown as NativeClient);
    Object.assign(adapter, {
      oculix: {
        async close() {
          calls.push("capture");
          throw captureFailure;
        },
      },
    });
    try {
      await assert.rejects(adapter[operation](), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [captureFailure, workerFailure]);
        assert.ok(calls.includes("guarded-settled"));
        return true;
      });
      assert.equal(calls.filter((call) => call === "guarded-start").length, 1);
    } finally {
      store.close();
    }
  }
});

test("successful native cleanup settles both owned components", async () => {
  for (const operation of ["close", "takeover"] as const) {
    const store = new Store(mkdtempSync(join(tmpdir(), "cur-native-cleanup-")));
    const calls: string[] = [];
    const adapter = new WindowsAdapter(store, false, {
      async close() {
        calls.push("close");
      },
      async call(method: string) {
        calls.push(method);
      },
    } as unknown as NativeClient);
    Object.assign(adapter, {
      oculix: {
        async close() {
          calls.push("capture");
        },
      },
    });
    try {
      await adapter[operation]();
      assert.deepEqual(calls, ["capture", operation]);
    } finally {
      store.close();
    }
  }
});
