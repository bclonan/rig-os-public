import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { WindowsAdapter, NativeClient } from "../src/adapters/native.js";
import { OllamaProvider } from "../src/providers/index.js";
import { calculatorAddition } from "../src/compiler/arithmetic.js";
import { structuredTask } from "../src/compiler/intent.js";
import { fact } from "../src/predicates/index.js";
import { writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import { Ajv } from "ajv";
const probe = new NativeClient();
const windows = await probe.call("windows"),
  matches = windows.filter((w: any) => w.title === "Calculator");
if (matches.length !== 1)
  throw new Error("Open and focus exactly one Calculator window");
const handle = matches[0].handle;
await probe.close();
const a = randomInt(110, 190),
  b = randomInt(210, 290),
  goal = `Use Calculator to add ${a} and ${b} and display the result.`;
const result: any = {
  goal,
  status: "NOT RUN",
  level: "native desktop",
  provider: process.env.CUR_PLANNER || "qwen3:1.7b",
};
const store = new Store(".data/calculator-" + Date.now()),
  adapter = await new WindowsAdapter(store, false).start(handle);
const runtime = new Runtime(store, adapter, {
  verify(_t, o) {
    return [
      fact(o, "uia.CalculatorResults", "Display is " + (a + b), "completion"),
    ];
  },
});
try {
  const operandSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      left: { type: "integer", minimum: 0, maximum: 999999 },
      right: { type: "integer", minimum: 0, maximum: 999999 },
      operation: { const: "add" },
    },
    required: ["left", "right", "operation"],
  };
  const plan: any = await new OllamaProvider(
    process.env.CUR_PLANNER || "qwen3:1.7b",
  ).generate(
    "Extract the two operands and requested operation from this instruction. Do not calculate the result or produce button clicks. Instruction: " +
      goal,
    operandSchema,
  );
  if (!new Ajv({ strict: false }).validate(operandSchema, plan))
    throw new Error("Invalid arithmetic contract");
  result.plan = plan;
  const skill = calculatorAddition(plan.left, plan.right, adapter.identity);
  runtime.registry.put(skill);
  const task = structuredTask(
    goal,
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    { left: plan.left, right: plan.right },
    skill.id,
  );
  task.expected = {};
  task.budgets = { steps: 20, deadlineMs: 30000 };
  runtime.submit(task, task.id);
  await runtime.execute(task.id);
  const run = store.run(task.id);
  result.status = run.status === "succeeded" ? "PASS" : "FAIL";
  result.run = run;
  result.events = store.events(0, run.id);
  result.independentExpected = a + b;
  const o = await adapter.observe();
  result.actual = o.facts["uia.CalculatorResults"];
  writeFileSync("evidence/calculator.bmp", store.artifactRead(o.image!));
} catch (e) {
  result.status = "FAIL";
  result.reason = String(e);
} finally {
  await runtime.close();
  writeFileSync("evidence/calculator.json", JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      goal,
      status: result.status,
      reason: result.reason,
      actual: result.actual,
      expected: result.independentExpected,
    }),
  );
}
