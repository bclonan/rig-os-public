import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { runGenericExample } from "../examples/generic.js";
import { LenseRuntimeClient, BridgeAdapter } from "../examples/lense-client.js";
import {
  CustomEnvironment,
  CustomProvider,
  customSkill,
} from "../examples/custom-plugin.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { compileIntent, structuredTask } from "../src/compiler/intent.js";
import type { Action, TaskContract } from "../src/contracts/index.js";
import { trainingPython } from "../src/learner/python.js";
import { Runtime } from "../src/runtime/index.js";
import { RuntimeClient } from "../src/sdk/index.js";
import { service } from "../src/service/index.js";
import { seedForm } from "../src/skills/index.js";
import { Store } from "../src/storage/index.js";

const fingerprint = () =>
  JSON.parse(
    execFileSync(trainingPython(), ["scripts/source-identity.py"], {
      encoding: "utf8",
    }),
  );

async function awaitRun(client: RuntimeClient, id: string) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const run = await client.status(id);
    if (
      ["succeeded", "failed", "cancelled", "awaiting_input", "paused"].includes(
        run.status,
      )
    )
      return run;
    await delay(20);
  }
  throw new Error("Example task did not finish within its contract budget");
}

/** Token travels through stdin, never a process argument, log, or report. */
async function agentOsSubmit(
  url: string,
  token: string,
  contract: TaskContract,
) {
  const script = [
    "import importlib.util,json,sys",
    "spec=importlib.util.spec_from_file_location('agent_os_example','examples/agent_os_client.py')",
    "module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)",
    "payload=json.load(sys.stdin)",
    "run=module.submit_goal(payload['url'],payload['token'],payload['contract'])",
    "print(json.dumps({'id':run['id'],'status':run['status']}))",
  ].join("\n");
  return new Promise<{ id: string; status: string }>((resolveChild, reject) => {
    const child = spawn(trainingPython(), ["-c", script], {
      windowsHide: true,
      stdio: "pipe",
      timeout: 20000,
    });
    let output = "",
      stderr = "";
    child.stdout.on("data", (data) => (output += String(data)));
    child.stderr.on("data", (data) => (stderr += String(data)));
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        assert.equal(code, 0, stderr.replaceAll(token, "[redacted]"));
        assert.equal(output.includes(token), false, "Token leaked to stdout");
        assert.equal(stderr.includes(token), false, "Token leaked to stderr");
        resolveChild(JSON.parse(output));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify({ url, token, contract }));
  });
}

export async function exerciseExampleContracts(storeParent?: string) {
  const report: Record<string, any> = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    status: "RUNNING",
    evidenceLevel: "headless browser, authenticated HTTP and injected host RPC",
    sourceBefore: fingerprint(),
    checks: [],
    limits: [
      "The installed Lense and Agent-OS host applications are unavailable and were not tested.",
      "The custom provider is a controlled local HTTP fixture, not a model quality test.",
      "No native, VM, or third-party application effect is claimed.",
    ],
  };
  const record = async (
    name: string,
    runtime: Runtime,
    browser: BrowserAdapter,
    id: string,
    expected: string,
  ) => {
    const run = runtime.store.run(id);
    assert.equal(run.status, "succeeded", run.error || "Expected success");
    const actual = await browser.page.locator("#result").textContent();
    assert.equal(
      actual,
      expected,
      "Independent DOM output must match the goal",
    );
    const events = runtime.store.events(0, id);
    const receipts = events
      .filter((event) => event.type === "acknowledged")
      .map((event) => (event.data as any).receipt || event.data);
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((receipt) => receipt.phase === "acknowledged"));
    assert.ok(events.some((event) => event.type === "completed"));
    assert.ok(events.some((event) => event.type === "verification"));
    report.checks.push({
      name,
      status: "PASS",
      runId: id,
      method: run.contract.method,
      model: run.model,
      steps: receipts.length,
      actual,
      receiptActionIds: receipts.map((receipt) => receipt.actionId),
      events: events.map((event) => ({ seq: event.seq, type: event.type })),
    });
  };

  for (const kind of ["lense", "custom"] as const) {
    const root = storeParent
      ? join(storeParent, kind + "-store")
      : mkdtempSync(join(tmpdir(), "cur-example-" + kind + "-"));
    const store = new Store(root);
    const browser = await new BrowserAdapter(store).start();
    const rpcCalls: { method: string; args: unknown }[] = [];
    const rpc = async (method: string, args: any) => {
      rpcCalls.push({ method, args });
      switch (method) {
        case "capture":
          return browser.observe();
        case "acquire":
          assert.equal(args.host, browser.host);
          assert.equal(args.session, browser.session);
          return { generation: await browser.acquire(args.runId) };
        case "actuate":
          return browser.execute(args);
        case "release":
          return browser.release(args.runId);
        case "takeover":
          return browser.takeover();
        case "return":
          return browser.returnControl();
        case "close":
          return browser.close();
        default:
          throw new Error("Unexpected host RPC operation " + method);
      }
    };
    const bridge = new (kind === "lense" ? BridgeAdapter : CustomEnvironment)(
      browser.host,
      browser.session,
      browser.identity,
      browser.capabilities,
      rpc,
    );
    const runtime = new Runtime(store, bridge);
    runtime.registry.put(seedForm());
    if (kind === "custom") runtime.registry.put(customSkill);
    const app = await service(runtime);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const url = "http://127.0.0.1:" + address.port;
    const token = store.token();
    const client = new RuntimeClient(url, token);
    const target = {
      host: browser.host,
      session: browser.session,
      identity: browser.identity,
    };
    try {
      assert.equal((await fetch(url + "/api/tasks")).status, 401);
      if (kind === "lense") {
        const lense = new LenseRuntimeClient(client);
        const task = structuredTask("Set display name", target, {
          name: "Lense wrapper " + randomUUID(),
        });
        const submitted = await lense.submitGoal(task);
        assert.equal((await lense.submitGoal(task)).id, submitted.id);
        await awaitRun(client, task.id);
        assert.equal(
          store.runs().length,
          1,
          "Idempotency must prevent duplicate tasks",
        );
        await record(
          "actual Lense submitGoal and bridge RPC",
          runtime,
          browser,
          task.id,
          String(task.parameters.name),
        );
        assert.deepEqual(
          await lense.evidence(task.id),
          store.events(0, task.id),
        );

        await browser.reset("ready", "shift");
        const generic = await runGenericExample(
          client,
          "Generic wrapper " + randomUUID(),
        );
        await record(
          "actual generic TypeScript example and SSE",
          runtime,
          browser,
          generic.task.id,
          String(generic.task.parameters.name),
        );
        assert.ok(generic.events.some((event) => event.type === "completed"));

        await browser.reset();
        const pythonTask = structuredTask("Set display name", target, {
          name: "Agent-OS wrapper " + randomUUID(),
        });
        const pythonRun = await agentOsSubmit(url, token, pythonTask);
        assert.equal(pythonRun.id, pythonTask.id);
        await awaitRun(client, pythonTask.id);
        await record(
          "actual Python Agent-OS submit_goal function",
          runtime,
          browser,
          pythonTask.id,
          String(pythonTask.parameters.name),
        );

        const incomplete = structuredTask("Set display name", target, {});
        incomplete.unresolved = ["The user must supply a display name"];
        await lense.submitGoal(incomplete);
        assert.equal(
          (await awaitRun(client, incomplete.id)).status,
          "awaiting_input",
        );
        const before = await browser.page.locator("#result").textContent();
        await lense.pause(incomplete.id);
        assert.equal((await client.status(incomplete.id)).status, "paused");
        assert.equal(
          await browser.page.locator("#result").textContent(),
          before,
        );
        assert.equal(
          store
            .events(0, incomplete.id)
            .some((event) => event.type === "acknowledged"),
          false,
        );
        report.checks.push({
          name: "Lense evidence and pause preserve unresolved input",
          status: "PASS",
          runId: incomplete.id,
        });
      } else {
        const planned = structuredTask(
          "Set custom display name",
          target,
          {
            name: "Custom wrapper " + randomUUID(),
          },
          customSkill.id,
        );
        let providerRequest: any;
        const providerServer = createServer(async (req, reply) => {
          let body = "";
          for await (const data of req) body += String(data);
          providerRequest = JSON.parse(body);
          reply.setHeader("content-type", "application/json");
          reply.end(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(planned) } }],
            }),
          );
        });
        await new Promise<void>((resolveServer) =>
          providerServer.listen(0, "127.0.0.1", resolveServer),
        );
        try {
          const providerAddress = providerServer.address();
          assert.ok(providerAddress && typeof providerAddress !== "string");
          const provider = new CustomProvider(
            "http://127.0.0.1:" + providerAddress.port,
            "controlled-contract-fixture",
          );
          const task = await compileIntent(
            planned.goal,
            target,
            ["edit"],
            [customSkill],
            provider,
          );
          assert.equal(providerRequest.response_format.type, "json_schema");
          assert.equal(
            providerRequest.response_format.json_schema.strict,
            true,
          );
          assert.equal(providerRequest.model, "controlled-contract-fixture");
          await client.submit(task);
          await awaitRun(client, task.id);
          await record(
            "actual custom provider, skill and environment exports",
            runtime,
            browser,
            task.id,
            String(task.parameters.name),
          );
        } finally {
          await new Promise<void>((resolveServer, reject) =>
            providerServer.close((error) =>
              error ? reject(error) : resolveServer(),
            ),
          );
        }
      }
      const action = rpcCalls.find((call) => call.method === "actuate")
        ?.args as Action;
      assert.ok(action);
      const beforeWrongTarget = rpcCalls.length;
      await assert.rejects(
        () => bridge.execute({ ...action, target: "foreign-target" }),
        /Wrong bridge host/,
      );
      assert.equal(
        rpcCalls.length,
        beforeWrongTarget,
        "Wrong target must fail before RPC",
      );
      const switched = new CustomEnvironment(
        bridge.host,
        bridge.session,
        bridge.identity,
        bridge.capabilities,
        async () => ({
          ...(await browser.observe()),
          target: "foreign-target",
        }),
      );
      await assert.rejects(() => switched.observe(), /Bridge switched target/);
      report.checks.push({
        name: kind + " host target binding",
        status: "PASS",
        rpcMethods: rpcCalls.map((call) => call.method),
      });
    } finally {
      await app.close();
    }
  }
  report.sourceAfter = fingerprint();
  report.sourceStable =
    report.sourceBefore.sha256 === report.sourceAfter.sha256;
  report.behaviorStatus = "PASS";
  report.status = report.sourceStable ? "PASS" : "SOURCE CHANGED";
  report.completedAt = new Date().toISOString();
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const directory = resolve(
    "evidence/completion/example-contracts",
    new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID(),
  );
  mkdirSync(directory, { recursive: true });
  try {
    const report = await exerciseExampleContracts(directory);
    writeFileSync(
      join(directory, "results.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify({
        status: report.status,
        checks: report.checks.length,
        sourceStable: report.sourceStable,
        directory,
      }),
    );
    if (report.status !== "PASS") process.exitCode = 1;
  } catch (error) {
    writeFileSync(
      join(directory, "results.json"),
      JSON.stringify(
        { schemaVersion: 1, status: "FAIL", reason: String(error) },
        null,
        2,
      ),
    );
    throw error;
  }
}
