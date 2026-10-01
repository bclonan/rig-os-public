import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/index.js";
import { Registry, seedForm, seal } from "../src/skills/index.js";
import { RuntimeClient } from "../src/sdk/index.js";
import { structuredTask } from "../src/compiler/intent.js";

const delay = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
test("CLI training reports a missing interpreter as failure", () => {
  const missing = join(
    mkdtempSync(join(tmpdir(), "cur-no-python-")),
    "missing",
  );
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "train"],
    {
      env: { ...process.env, CUR_TRAINING_PYTHON: missing },
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot start train:.*ENOENT/);
});
async function until(
  check: () => Promise<boolean> | boolean,
  message: string,
  timeout = 15000,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay();
  }
  throw new Error(message);
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port as number;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
function launch(
  command: string,
  root: string,
  port: number,
  extra: string[] = [],
) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", command, ...extra],
    {
      env: { ...process.env, CUR_DATA: root, CUR_PORT: String(port) },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { child, finished, output: () => output };
}
async function command(name: string, root: string, port: number) {
  const run = launch(name, root, port);
  const timeout = setTimeout(() => run.child.kill(), 25000);
  try {
    return { code: await run.finished, output: run.output() };
  } finally {
    clearTimeout(timeout);
  }
}
async function ready(root: string, port: number, pid: number) {
  await until(async () => {
    try {
      const client = new RuntimeClient(
        `http://127.0.0.1:${port}`,
        readFileSync(join(root, "service.token"), "utf8"),
      );
      return (await client.request("/api/service")).pid === pid;
    } catch {
      return false;
    }
  }, "Service did not become ready");
}

test(
  "CLI stop and restart preserve data and token, pause work, drain streams and recover stale locks",
  { timeout: 60000 },
  async () => {
    const root = join(mkdtempSync(join(tmpdir(), "cur-lifecycle-")), "store");
    const port = await freePort();
    const store = new Store(root);
    const base = seedForm();
    new Registry(store).put(base);
    const wait = seal({
      ...base,
      id: "lifecycle.wait",
      machine: {
        initial: "wait",
        states: [
          {
            id: "wait",
            monitor: [],
            steps: [
              {
                id: "wait",
                operation: "wait",
                args: {},
                scope: "edit",
                waitMs: 10000,
              },
            ],
          },
        ],
      },
      budgets: { steps: 8, retries: 0 },
    });
    new Registry(store).put(wait);
    store.close();
    const children: ReturnType<typeof launch>[] = [];
    const start = (name = "start") => {
      const run = launch(name, root, port);
      children.push(run);
      return run;
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const first = start();
      await ready(root, port, first.child.pid!);
      const token = readFileSync(join(root, "service.token"), "utf8");
      assert.equal((await command("token", root, port)).output.trim(), token);
      assert.match((await command("status", root, port)).output, /Running at/);
      const duplicate = await command("start", root, port);
      assert.equal(duplicate.code, 0);
      assert.match(duplicate.output, /already running/);
      assert.ok(!duplicate.output.includes(token));
      first.child.stdin.write("token\n");
      await until(
        () => first.output().includes(token),
        "Terminal token command did not respond",
      );
      const client = new RuntimeClient(`http://127.0.0.1:${port}`, token);
      assert.equal(
        (await fetch(client.url + "/api/service/shutdown", { method: "POST" }))
          .status,
        401,
      );
      const caps = await client.request("/api/capabilities");
      const target = {
        host: caps.host,
        session: caps.session,
        identity: caps.identity,
      };
      const task = structuredTask("Persist this result", target, {
        name: "Lifecycle Cedar",
      });
      await client.submit(task);
      await until(
        async () => (await client.status(task.id)).status === "succeeded",
        "Task did not complete",
      );
      await client.request("/api/record", "POST", { runId: task.id });
      const waiting = structuredTask(
        "Pause this wait on shutdown",
        target,
        { name: "Pending" },
        wait.id,
      );
      await client.submit(waiting);
      await until(
        async () =>
          (await client.request(`/api/tasks/${waiting.id}/evidence`)).some(
            (e: any) => e.type === "waiting",
          ),
        "Wait did not start",
      );
      const queued = structuredTask("Queued work stays paused", target, {
        name: "Queue",
      });
      await client.submit(queued);
      const stream = await fetch(client.url + "/api/events", {
        headers: { authorization: "Bearer " + token },
      });
      reader = stream.body!.getReader();
      await reader.read();
      const stopped = await command("stop", root, port);
      assert.equal(stopped.code, 0, stopped.output);
      assert.equal(await first.finished, 0);
      while (!(await reader.read()).done) {}
      await reader.cancel();
      reader = undefined;
      assert.ok(!existsSync(join(root, "coordinator.lock")));
      assert.match(
        (await command("stop", root, port)).output,
        /already stopped/,
      );
      assert.match((await command("status", root, port)).output, /is stopped/);
      assert.equal((await command("token", root, port)).output.trim(), token);

      // A process that has exited cannot retain ownership after a crash.
      writeFileSync(join(root, "coordinator.lock"), String(first.child.pid));
      const second = start();
      await ready(root, port, second.child.pid!);
      assert.equal(readFileSync(join(root, "service.token"), "utf8"), token);
      assert.equal((await client.status(task.id)).status, "succeeded");
      assert.equal((await client.status(waiting.id)).status, "paused");
      assert.equal((await client.status(queued.id)).status, "paused");

      const third = start("restart");
      await ready(root, port, third.child.pid!);
      assert.equal(await second.finished, 0);
      assert.equal(readFileSync(join(root, "service.token"), "utf8"), token);
      third.child.stdin.write("status\nstop\n");
      assert.equal(await third.finished, 0);
      assert.match(third.output(), /Runtime stopped/);
      assert.ok(!existsSync(join(root, "coordinator.lock")));
    } finally {
      await reader?.cancel().catch(() => {});
      for (const run of children) {
        if (run.child.exitCode === null) {
          run.child.stdin.write("stop\n");
        }
      }
      for (const run of children) {
        const force = setTimeout(() => run.child.kill(), 5000);
        await run.finished.catch(() => {});
        clearTimeout(force);
      }
    }
  },
);

test(
  "failed startup releases the store and invalid configuration fails without a stack trace",
  { timeout: 20000 },
  async () => {
    const root = join(mkdtempSync(join(tmpdir(), "cur-port-")), "store");
    const blocker = createServer((socket) => socket.end());
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", resolve),
    );
    const port = (blocker.address() as any).port;
    try {
      const result = await command("start", root, port);
      assert.equal(result.code, 1);
      assert.match(result.output, /already used by another process/);
      assert.ok(!existsSync(join(root, "coordinator.lock")));
      const store = new Store(root);
      store.close();
      store.close();
      const invalid = await command("start", root, 70000);
      assert.equal(invalid.code, 1);
      assert.match(invalid.output, /CUR_PORT must/);
      assert.doesNotMatch(invalid.output, /at ModuleJob/);
      const corruptRoot = mkdtempSync(join(tmpdir(), "cur-corrupt-"));
      writeFileSync(
        join(corruptRoot, "runtime.sqlite"),
        "Not a SQLite database".repeat(20),
      );
      assert.throws(() => new Store(corruptRoot), /database/);
      assert.ok(!existsSync(join(corruptRoot, "coordinator.lock")));
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  },
);
