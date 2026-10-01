import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { seedForm } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { service } from "../src/service/index.js";
import { RuntimeClient } from "../src/sdk/index.js";
import { AdaptiveSelector } from "../src/learner/selector.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("authenticated service, TS/Python SDK, reconnectable events, MCP and adaptive selection share core", async () => {
  const root = join(mkdtempSync(join(tmpdir(), "cur-api-")), "store"),
    store = new Store(root),
    adapter = await new BrowserAdapter(store).start();
  const selector = new AdaptiveSelector(store),
    runtime = new Runtime(
      store,
      adapter,
      undefined,
      undefined,
      selector.select.bind(selector),
    );
  runtime.registry.put(seedForm());
  const app = await service(runtime);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as any;
  const url = "http://127.0.0.1:" + address.port,
    token = store.token(),
    client = new RuntimeClient(url, token);
  try {
    writeFileSync(join(root, "service.token"), token);
    const ownerBefore = readFileSync(join(root, "coordinator.lock"), "utf8");
    const duplicateStart = await new Promise<{
      code: number | null;
      output: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "start"],
        {
          env: {
            ...process.env,
            CUR_DATA: root,
            CUR_PORT: String(address.port),
          },
          windowsHide: true,
          timeout: 10000,
        },
      );
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, output }));
    });
    assert.equal(duplicateStart.code, 0, duplicateStart.output);
    assert.match(duplicateStart.output, /already running/);
    assert.ok(duplicateStart.output.includes(url));
    assert.ok(!duplicateStart.output.includes(token));
    assert.equal(
      readFileSync(join(root, "coordinator.lock"), "utf8"),
      ownerBefore,
    );
    assert.equal((await fetch(url + "/api/tasks")).status, 401);
    assert.equal(
      (
        await fetch(url + "/api/tasks", {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
      401,
    );
    const c = await client.request("/api/capabilities");
    await adapter.reset("both", "shift");
    const task = structuredTask(
      "Set display name",
      { host: c.host, session: c.session, identity: c.identity },
      { name: "Service SDK" },
      "auto",
    );
    const submitted = await client.submit(task);
    assert.equal((await client.submit(task)).id, submitted.id);
    assert.equal(store.runs().length, 1);
    const abort = new AbortController();
    let cursor = 0;
    for await (const e of client.events(0, abort.signal)) {
      cursor = e.seq;
      if (
        e.runId === task.id &&
        ["completed", "interrupted"].includes(e.type)
      ) {
        abort.abort();
        break;
      }
    }
    assert.equal((await client.status(task.id)).status, "succeeded");
    assert.ok(cursor > 0);
    const python = await new Promise<string>((resolve, reject) => {
      const p = spawn(
        "python",
        [
          "-c",
          "import sys;sys.path.insert(0,'sdk/python');from computer_use_runtime import RuntimeClient; print(RuntimeClient(sys.argv[1],sys.argv[2]).request('/api/capabilities')['identity'])",
          url,
          token,
        ],
        { windowsHide: true },
      );
      let output = "";
      p.stdout.on("data", (d) => (output += d));
      p.on("error", reject);
      p.on("exit", (code) =>
        code === 0 ? resolve(output) : reject(new Error("Python SDK failed")),
      );
    });
    assert.match(python, /browser-fixture-v1/);
    const tokenFile = join(root, "mcp.token");
    writeFileSync(tokenFile, token);
    const mcp = new Client({ name: "contract-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/service/mcp.ts"],
      env: {
        ...(process.env as Record<string, string>),
        CUR_URL: url,
        CUR_TOKEN_FILE: tokenFile,
      },
    });
    await mcp.connect(transport);
    const list = await mcp.listTools();
    assert.equal(list.tools.length, 4);
    const result = await mcp.callTool({
      name: "runtime_status",
      arguments: { runId: task.id },
    });
    assert.equal(result.isError, undefined);
    await mcp.close();
    await assert.rejects(() =>
      client.submit({ ...task, goal: "conflicting" }, task.id),
    );
    assert.equal(
      (
        await fetch(url + "/api/tasks", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      400,
    );
  } finally {
    await selector.close();
    await app.close();
  }
});
