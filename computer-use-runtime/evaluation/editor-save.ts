import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { NativeClient, WindowsAdapter } from "../src/adapters/native.js";
import { OllamaProvider } from "../src/providers/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { seal, seedForm } from "../src/skills/index.js";
import { fact } from "../src/predicates/index.js";
if (process.argv.includes("--prepare")) {
  const path = resolve("evidence/editor-" + randomInt(100000, 999999) + ".txt");
  const output: any = await new OllamaProvider("qwen3:1.7b").generate(
    "Write one short original sentence, fewer than 80 characters, about a cedar tree. Return JSON with text. Do not include any instructions or quotations.",
    {
      type: "object",
      properties: { text: { type: "string", maxLength: 80 } },
      required: ["text"],
      additionalProperties: false,
    },
  );
  if (typeof output.text !== "string" || output.text.length > 80)
    throw new Error("Generated sentence exceeds native budget");
  const process = spawn(
    resolve("native/target/release/disposable-editor.exe"),
    [],
    {
      env: { ...globalThis.process.env, CUR_EDITOR_SAVE_PATH: path },
      windowsHide: false,
      stdio: "ignore",
      detached: true,
    },
  );
  process.unref();
  writeFileSync(
    "evidence/editor-plan.json",
    JSON.stringify(
      { path, text: output.text, pid: process.pid, provider: "qwen3:1.7b" },
      null,
      2,
    ),
  );
  console.log(
    "Disposable editor opened with an explicit new-file save target.",
  );
} else {
  const plan = JSON.parse(readFileSync("evidence/editor-plan.json", "utf8"));
  if (existsSync(plan.path)) throw new Error("Refusing overwrite");
  const probe = new NativeClient();
  const window = (await probe.call("windows")).find(
    (w: any) => w.pid === plan.pid,
  );
  await probe.close();
  if (!window) throw new Error("Disposable editor window unavailable");
  const store = new Store(".data/editor-save-" + Date.now()),
    adapter = await new WindowsAdapter(store, false).start(window.handle);
  const runtime = new Runtime(store, adapter, {
    verify(_t, o) {
      const saved = existsSync(plan.path)
        ? readFileSync(plan.path, "utf8")
        : undefined;
      return [
        fact(
          {
            ...o,
            facts: {
              ...o.facts,
              ...(saved === undefined ? {} : { savedText: saved }),
            },
          },
          "savedText",
          plan.text,
          "completion",
        ),
      ];
    },
  });
  const result: any = {
    goal: `Type the sentence ${JSON.stringify(plan.text)} in the disposable text editor and save a new file to ${plan.path}.`,
    level: "native desktop, owned disposable editor",
    plan,
    status: "NOT RUN",
  };
  try {
    const skill = seal({
      ...seedForm(),
      id: "native.editor-save",
      description: "Type and explicitly save in the disposable Windows editor",
      inputs: { text: "string" },
      outputs: ["savedText"],
      capabilities: ["click", "type", "invoke"],
      compatibility: [adapter.identity],
      effects: ["edit", "save"],
      preconditions: [],
      machine: {
        initial: "edit",
        states: [
          {
            id: "edit",
            steps: [
              {
                id: "focus",
                operation: "click",
                scope: "edit",
                args: { x: 100, y: 120 },
              },
              {
                id: "type",
                operation: "type",
                scope: "edit",
                args: { text: "$text" },
              },
              {
                id: "save",
                operation: "invoke",
                scope: "save",
                args: { locator: "102" },
              },
            ],
            monitor: ["focused"],
          },
        ],
      },
    });
    runtime.registry.put(skill);
    const task = structuredTask(
      result.goal,
      {
        host: adapter.host,
        session: adapter.session,
        identity: adapter.identity,
      },
      { text: plan.text },
      skill.id,
    );
    task.effects = ["edit", "save"];
    task.expected = { savedText: plan.text };
    task.budgets.deadlineMs = 30000;
    runtime.submit(task, task.id);
    await runtime.execute(task.id);
    result.run = store.run(task.id);
    result.events = store.events(0, task.id);
    result.status = result.run.status === "succeeded" ? "PASS" : "FAIL";
    result.independentText = existsSync(plan.path)
      ? readFileSync(plan.path, "utf8")
      : null;
    const o = await adapter.observe();
    writeFileSync("evidence/editor-save.bmp", store.artifactRead(o.image!));
  } catch (e) {
    result.status = "FAIL";
    result.reason = String(e);
  } finally {
    await runtime.close();
    writeFileSync("evidence/editor-save.json", JSON.stringify(result, null, 2));
    console.log(
      JSON.stringify({
        status: result.status,
        reason: result.reason,
        error: result.run?.error,
      }),
    );
  }
}
