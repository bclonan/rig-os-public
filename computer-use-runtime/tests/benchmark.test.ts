import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { Store } from "../src/storage/index.js";
import { BenchmarkEnvironmentAdapter } from "../src/adapters/benchmark.js";
import { BenchmarkCoordinator } from "../evaluation/benchmark-coordinator.js";
import { seal, seedForm } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import type { Action } from "../src/contracts/index.js";

const grant = {
  host: "owned-test-runner",
  session: "test-session",
  identity: "benchmark-owned-desktop",
  platform: "Linux" as const,
  track: "structured" as const,
};
async function pageFixture() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 320, height: 240 },
    });
    await page.setContent(
      '<button style="position:absolute;left:20px;top:20px;width:100px;height:40px" onclick="document.querySelector(\'#result\').textContent=\'Clicked 17\'">Apply</button><div id="result">Pending</div>',
    );
    // setContent waits for load. Snapshot tests need the fixture's first text paint.
    // A failed paint barrier or screenshot remains a failure, with no capture retry.
    await page.waitForFunction(
      () =>
        performance
          .getEntriesByType("paint")
          .some((entry) => entry.name === "first-contentful-paint"),
      undefined,
      { polling: "raf", timeout: 5000 },
    );
    return {
      browser,
      page,
      snapshot: async () => ({
        screenshot: (await page.screenshot()).toString("base64"),
        accessibility_tree: (await page.locator("#result").textContent()) || "",
      }),
    };
  } catch (error) {
    try {
      await browser.close();
    } finally {
      throw error;
    }
  }
}
test("benchmark adapter binds runner receipts, rejects hidden inputs and keeps dispatched uncertainty quarantined", async () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "cur-benchmark-boundary-")),
  );
  const fixture = await pageFixture();
  const adapter = new BenchmarkEnvironmentAdapter(store, grant);
  try {
    const snapshot = await fixture.snapshot();
    assert.throws(
      () =>
        adapter.receive(
          { ...snapshot, reward: 1 },
          null,
          grant.host,
          grant.session,
        ),
      /evaluator/,
    );
    assert.throws(
      () => adapter.receive(snapshot, null, "foreign", grant.session),
      /session/,
    );
    assert.throws(
      () =>
        new BenchmarkEnvironmentAdapter(store, {
          ...grant,
          track: "pixel",
        }).receive(snapshot, null, grant.host, grant.session),
      /Pixel track/,
    );
    adapter.receive(snapshot, null, grant.host, grant.session);
    const observation = await adapter.observe();
    const generation = await adapter.acquire("run-1");
    const action: Action = {
      schemaVersion: 1,
      id: randomUUID(),
      runId: "run-1",
      requester: "local-user",
      host: grant.host,
      session: grant.session,
      target: grant.identity,
      observationId: observation.id,
      revision: observation.revision,
      frame: observation.frame,
      operation: "click",
      args: { x: 42, y: 35 },
      deadline: Date.now() + 1000,
      scope: "edit",
      generation,
    };
    assert.equal(
      (await adapter.execute({ ...action, target: "foreign" })).phase,
      "rejected",
    );
    const work = adapter.execute(action);
    assert.equal(adapter.poll()!.id, action.id);
    assert.equal(
      adapter.poll(),
      undefined,
      "Emitted actions must never replay",
    );
    assert.throws(
      () =>
        adapter.receive(snapshot, "foreign-action", grant.host, grant.session),
      /acknowledgment/,
    );
    adapter.receive(snapshot, action.id, grant.host, grant.session);
    const receipt = await work;
    assert.equal(receipt.phase, "acknowledged");
    assert.equal(receipt.actionId, action.id);
    assert.equal(receipt.runId, "run-1");
    assert.match(receipt.detail, /independent verification/);
    const next = await adapter.observe();
    const uncertain = adapter.execute({
      ...action,
      id: randomUUID(),
      observationId: next.id,
      revision: next.revision,
      deadline: Date.now() + 100,
    });
    adapter.poll();
    await assert.rejects(uncertain, /uncertain/);
    await assert.rejects(() => adapter.acquire("new-run"), /Reset/);
    await adapter.takeover();
    await assert.rejects(() => adapter.returnControl(), /Reset/);
    await assert.rejects(() => adapter.acquire("after-takeover"), /Reset/);
    await adapter.reset();
    assert.equal(adapter.poll(), undefined);
    adapter.receive(snapshot, null, grant.host, grant.session);
    const current = await adapter.observe();
    const controller = new AbortController();
    const safe = adapter.execute(
      {
        ...action,
        id: randomUUID(),
        observationId: current.id,
        revision: current.revision,
        deadline: Date.now() + 1000,
        generation: await adapter.acquire("run-1"),
      },
      controller.signal,
    );
    controller.abort();
    assert.equal((await safe).phase, "rejected");
    assert.equal(adapter.poll(), undefined);
  } finally {
    await adapter.close();
    await fixture.browser.close();
    store.close();
  }
});

function clickSkill() {
  return seal({
    ...seedForm(),
    id: "benchmark.owned.click",
    status: "seed",
    preconditions: [],
    capabilities: ["click"],
    inputs: {},
    compatibility: [grant.identity],
    machine: {
      initial: "click",
      states: [
        {
          id: "click",
          monitor: ["focused"],
          steps: [
            {
              id: "click",
              operation: "click",
              args: { x: 42, y: 35 },
              scope: "edit",
            },
          ],
        },
      ],
    },
  });
}
test("runner acknowledgment without independent public completion measurement cannot produce DONE", async () => {
  const fixture = await pageFixture();
  const skill = clickSkill();
  const coordinator = new BenchmarkCoordinator({
    storeDirectory: mkdtempSync(join(tmpdir(), "cur-benchmark-unknown-")),
    grant,
    skills: [skill],
    task: (instruction, target) =>
      structuredTask(instruction, target, { name: "Clicked 17" }, skill.id),
  });
  let pending: string | null = null,
    result: any;
  try {
    for (let round = 0; round < 8; round++) {
      result = await coordinator.request({
        id: randomUUID(),
        method: "next_action",
        host: grant.host,
        session: grant.session,
        instruction: "Click authorized target",
        observation: await fixture.snapshot(),
        pending,
      });
      pending = result.id || null;
      if (result.operation === "click")
        await fixture.page.mouse.click(result.args.x, result.args.y);
      if (["done", "fail"].includes(result.operation)) break;
    }
    assert.equal(
      await fixture.page.locator("#result").textContent(),
      "Clicked 17",
    );
    assert.equal(result.operation, "fail");
    assert.equal(coordinator.store.runs()[0].status, "blocked");
    assert.ok(
      coordinator.store
        .events()
        .some(
          (event) =>
            event.type === "verification" &&
            (event.data as any).evidence[0].truth === "UNKNOWN",
        ),
    );
  } finally {
    await coordinator.close();
    await fixture.browser.close();
  }
});
test("actual Runtime lane returns one action, independent browser callback measurement decides completion", async () => {
  const fixture = await pageFixture();
  const skill = clickSkill();
  const coordinator = new BenchmarkCoordinator({
    storeDirectory: mkdtempSync(join(tmpdir(), "cur-benchmark-runtime-")),
    grant: {
      ...grant,
      measure: (snapshot) => ({
        facts: { result: snapshot.accessibility_tree || "" },
      }),
    },
    skills: [skill],
    task: (instruction, target) =>
      structuredTask(instruction, target, { name: "Clicked 17" }, skill.id),
  });
  let pending: string | null = null,
    effects = 0,
    result: any;
  try {
    for (let round = 0; round < 8; round++) {
      result = await coordinator.request({
        id: randomUUID(),
        method: "next_action",
        host: grant.host,
        session: grant.session,
        instruction: "Click the authorized Apply button",
        observation: await fixture.snapshot(),
        pending,
      });
      pending = result.id || null;
      if (result.operation === "click") {
        await fixture.page.mouse.click(result.args.x, result.args.y);
        effects++;
      }
      if (["done", "fail"].includes(result.operation)) break;
    }
    assert.equal(result.operation, "done");
    assert.equal(effects, 1);
    assert.equal(
      await fixture.page.locator("#result").textContent(),
      "Clicked 17",
    );
    const events = coordinator.store.events();
    assert.equal(
      events.filter((event) => event.type === "requested").length,
      1,
    );
    assert.equal(
      events.filter((event) => event.type === "acknowledged").length,
      1,
    );
    assert.equal(coordinator.store.runs()[0].status, "succeeded");
    assert.ok(
      events.some(
        (event) =>
          event.type === "verification" &&
          (event.data as any).evidence.every(
            (item: any) => item.truth === "TRUE",
          ),
      ),
    );
  } finally {
    await coordinator.close();
    await fixture.browser.close();
  }
});

test("Python private stdio bridge exercises the same Runtime coordinator and preserves original mapper contract", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cur-benchmark-stdio-"));
  const fixture = await pageFixture();
  try {
    writeFileSync(
      join(directory, "screenshot.png"),
      await fixture.page.screenshot(),
    );
    const configuration = {
      storeDirectory: join(directory, "store"),
      grant,
      skills: [clickSkill()],
    };
    writeFileSync(
      join(directory, "configuration.mjs"),
      `import {randomUUID} from 'node:crypto';\nexport const configuration=${JSON.stringify(configuration)};\nconfiguration.grant.measure=s=>({facts:{result:s.accessibility_tree}});\nconfiguration.task=(instruction,target)=>({schemaVersion:1,id:randomUUID(),correlationId:randomUUID(),requester:'local-user',goal:instruction,target,parameters:{},effects:['edit'],requirements:[],unresolved:[],method:'benchmark.owned.click',expected:{result:'Measured public output'},budgets:{steps:4,deadlineMs:10000}});\n`,
    );
    const code = `import sys,pathlib\nsys.path.insert(0, 'sdk/python')\nfrom benchmark_adapter import CoordinatorProcessBridge,BenchmarkAgent\nwith CoordinatorProcessBridge(sys.argv[1],sys.argv[2],mode="source") as bridge:\n agent=BenchmarkAgent(bridge,'owned-test-runner','test-session','structured')\n agent.reset()\n image=pathlib.Path(sys.argv[3]).read_bytes()\n count=0\n for step in range(8):\n  _,actions=agent.predict('Click authorized target',{'screenshot':image,'accessibility_tree':'Measured public output' if count else 'Pending','reward':1,'evaluator':{'private':True}})\n  if actions[0]=='DONE':break\n  if isinstance(actions[0],dict):\n   assert actions==[{'action_type':'CLICK','x':42,'y':35,'button':'left'}]\n   count+=1\n assert count==1 and actions==['DONE'],actions\nprint('Private process Runtime contract PASS; synthetic public text; VM score unavailable')\n`;
    const run = spawnSync(
      "python",
      [
        "-c",
        code,
        resolve("."),
        join(directory, "configuration.mjs"),
        join(directory, "screenshot.png"),
      ],
      { encoding: "utf8", timeout: 20000, windowsHide: true },
    );
    assert.equal(run.status, 0, run.stderr + run.stdout);
    assert.match(run.stdout, /Runtime contract PASS/);
    const original = spawnSync("python", ["evaluation/benchmark_contract.py"], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(original.status, 0, original.stderr);
    assert.match(original.stdout, /PASS/);
  } finally {
    await fixture.browser.close();
  }
});
test("private process write deadline terminates an unresponsive child without replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "cur-benchmark-stalled-"));
  const config = join(directory, "configuration.mjs");
  writeFileSync(
    config,
    "await new Promise(resolve=>setTimeout(resolve,60000)); export const configuration={};\n",
  );
  const code = `import sys,time\nsys.path.insert(0,'sdk/python')\nfrom benchmark_adapter import CoordinatorProcessBridge\nbridge=CoordinatorProcessBridge(sys.argv[1],sys.argv[2],timeout=1,mode="source")\nstarted=time.monotonic()\ntry:\n bridge.next_action('Bounded stalled protocol test',{'screenshot':'A'*6000000},None,'host','session')\n raise AssertionError('Expected bounded pipe write failure')\nexcept RuntimeError as error:\n assert 'Do not replay' in str(error),error\n assert time.monotonic()-started<4\n assert bridge.process.poll() is not None\nfinally:bridge.close()\nprint('Bounded stalled-child transport PASS')\n`;
  const run = spawnSync("python", ["-c", code, resolve("."), config], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 8000,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
