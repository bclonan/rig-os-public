import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { seedForm } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { Recorder } from "../src/recorder/index.js";
import { compileDemonstrations } from "../src/compiler/experience.js";
test("live standalone runtime compiles multiple demonstrations and runs an unseen input", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-test-")));
  const adapter = await new BrowserAdapter(store).start();
  const rt = new Runtime(store, adapter);
  rt.registry.put(seedForm());
  try {
    const recorder = new Recorder(store);
    const demos = [];
    for (const name of ["Aster-11", "Birch-27", "Cedar-39"]) {
      await adapter.reset();
      const t = structuredTask(
        "Enter display name",
        {
          host: adapter.host,
          session: adapter.session,
          identity: adapter.identity,
        },
        { name },
      );
      const r = rt.submit(t, t.id);
      await rt.execute(r.id);
      assert.equal(
        store.run(r.id).status,
        "succeeded",
        store.run(r.id).error || "",
      );
      demos.push(recorder.capture(r.id));
    }
    const compiled = compileDemonstrations(demos);
    const addedArgument = structuredClone(demos);
    for (const demo of addedArgument.slice(1))
      demo.steps.find(
        (step) => step.action.operation === "click",
      )!.action.args.button = "right";
    assert.throws(
      () => compileDemonstrations(addedArgument),
      /Argument presence disagrees/,
    );
    const removedArgument = structuredClone(demos);
    removedArgument[0].steps.find(
      (step) => step.action.operation === "click",
    )!.action.args.button = "left";
    assert.throws(
      () => compileDemonstrations(removedArgument),
      /Argument presence disagrees/,
    );
    const changedScope = structuredClone(demos);
    changedScope[1].steps[0].action.scope = "save";
    assert.throws(
      () => compileDemonstrations(changedScope),
      /Effect scopes disagree/,
    );
    assert.equal(compiled.inputs.name, "string");
    assert.equal(compiled.machine.states[0].steps[0].args.value, "$name");
    rt.registry.put(compiled);
    const regressionIds: string[] = [];
    for (const name of [
      "Regression Ash",
      "Regression Elm",
      "Regression Pine",
    ]) {
      await adapter.reset("ready", "shift");
      const task = structuredTask(
        "Regression",
        {
          host: adapter.host,
          session: adapter.session,
          identity: adapter.identity,
        },
        { name },
        compiled.id,
      );
      const result = await rt.testCandidate(task, compiled);
      assert.equal(result.status, "succeeded", result.error || "");
      regressionIds.push(result.id);
    }
    rt.registry.publish(compiled.id, regressionIds);
    await adapter.reset("ready", "shift");
    const t = structuredTask(
      "Enter new display name",
      {
        host: adapter.host,
        session: adapter.session,
        identity: adapter.identity,
      },
      { name: "Unseen Willow-851" },
      compiled.id,
    );
    const r = rt.submit(t, t.id);
    await rt.execute(r.id);
    assert.equal(
      store.run(r.id).status,
      "succeeded",
      store.run(r.id).error || "",
    );
    assert.equal(
      await adapter.page.locator("#result").textContent(),
      "Unseen Willow-851",
    );
  } finally {
    await rt.close();
  }
});
