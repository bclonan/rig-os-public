import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { calculatorAddition } from "../src/compiler/arithmetic.js";
import { structuredTask } from "../src/compiler/intent.js";
import { Runtime } from "../src/runtime/index.js";
import { Store } from "../src/storage/index.js";

test("bounded addition executes every required control and retains an explicit caller step limit", async () => {
  for (const [left, right, callerLimit] of [
    [0, 0, 5],
    [755, 632, 9],
    [999999, 999999, 15],
    [755, 632, 8],
  ]) {
    const store = new Store(mkdtempSync(join(tmpdir(), "cur-addition-")));
    const adapter = await new BrowserAdapter(store).start();
    const runtime = new Runtime(store, adapter);
    try {
      // This is a browser test of the capsule runner, using actual button
      // callbacks. The native Calculator examiner separately checks UIA.
      const controls = [
        "clearButton",
        "plusButton",
        "equalButton",
        ...Array.from({ length: 10 }, (_, digit) => `num${digit}Button`),
      ];
      await adapter.page
        .setContent(`<main id="editor"><input id="name"><output id="result"></output>${controls.map((id) => `<button data-control="${id}">${id}</button>`).join("")}</main>
        <script>
          let operand = '', prior = 0;
          window.invocations = [];
          document.querySelectorAll('button').forEach(button => button.onclick = () => {
            const id = button.dataset.control;
            window.invocations.push(id);
            if (id === 'clearButton') { operand = ''; prior = 0; document.querySelector('#result').textContent = ''; }
            else if (id === 'plusButton') { prior = Number(operand); operand = ''; }
            else if (id === 'equalButton') document.querySelector('#result').textContent = String(prior + Number(operand));
            else operand += id.slice(3, 4);
          });
        </script>`);
      adapter.capabilities.push("invoke");
      const execute = adapter.execute.bind(adapter);
      adapter.execute = (action, signal) =>
        execute({ ...action, operation: "click" }, signal);
      const skill = calculatorAddition(left, right, adapter.identity);
      runtime.registry.put(skill);
      const task = structuredTask(
        "Add the exact operands",
        {
          host: adapter.host,
          session: adapter.session,
          identity: adapter.identity,
        },
        { left, right, name: String(left + right) },
        skill.id,
      );
      task.budgets.steps = callerLimit;
      runtime.submit(task, task.id);
      await runtime.execute(task.id);
      const run = store.run(task.id);
      const invocations = await adapter.page.evaluate(
        () => (window as unknown as { invocations: string[] }).invocations,
      );
      assert.equal(invocations.length, callerLimit);
      if (callerLimit === 8) {
        assert.equal(run.status, "blocked");
        assert.match(run.error!, /Step budget exceeded/);
        assert.equal(invocations.includes("equalButton"), false);
        assert.equal(await adapter.page.locator("#result").textContent(), "");
      } else {
        assert.equal(run.status, "succeeded", run.error || "");
        assert.equal(
          await adapter.page.locator("#result").textContent(),
          String(left + right),
        );
        assert.equal(invocations.at(-1), "equalButton");
      }
    } finally {
      await runtime.close();
    }
  }
});
