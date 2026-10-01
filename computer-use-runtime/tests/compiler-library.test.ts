import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { seedForm, seal } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { Recorder, type Demonstration } from "../src/recorder/index.js";
import {
  compileWorkflowLibrary,
  importWorkflowLibrary,
} from "../src/compiler/library.js";

test("compiler extracts a shared parameterized subskill and both parents execute unseen inputs", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-library-")));
  const adapter = await new BrowserAdapter(store).start();
  const runtime = new Runtime(store, adapter);
  try {
    const plain = seedForm();
    const observed = seal({
      ...plain,
      id: "form.observed",
      capabilities: [...plain.capabilities, "observe"],
      machine: {
        ...plain.machine,
        states: plain.machine.states.map((state, index) =>
          index
            ? state
            : {
                ...state,
                steps: [
                  {
                    id: "inspect",
                    operation: "observe",
                    scope: "edit",
                    args: {},
                  },
                  ...state.steps,
                ],
              },
        ),
      },
    });
    runtime.registry.put(plain);
    runtime.registry.put(observed);
    const target = {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    };
    const demos: Demonstration[] = [];
    for (const method of [plain.id, observed.id])
      for (const name of ["Develop Alder", "Develop Birch", "Develop Cedar"]) {
        await adapter.reset();
        const task = structuredTask(
          "Enter display name",
          target,
          { name },
          method,
        );
        runtime.submit(task, task.id);
        await runtime.execute(task.id);
        assert.equal(store.run(task.id).status, "succeeded");
        demos.push(new Recorder(store).capture(task.id));
      }
    const library = compileWorkflowLibrary(demos, "extracted");
    assert.equal(library.dependencies.length, 1);
    assert.equal(library.extractions[0].operations, 2);
    assert.equal(library.extractions[0].methods.length, 2);
    assert.deepEqual(library.dependencies[0].inputs, { name: "string" });
    for (const parent of library.roots) {
      assert.ok(
        parent.machine.states.some((state) =>
          state.steps.some(
            (step) => step.subskill === library.dependencies[0].id,
          ),
        ),
      );
      await adapter.reset("ready", "shift");
      const task = structuredTask(
        "Enter unseen held-out display name",
        target,
        { name: "Unseen Sequoia " + parent.id },
        parent.id,
      );
      const result = await runtime.testCandidate(
        task,
        parent,
        undefined,
        library.dependencies,
      );
      assert.equal(
        result.status,
        "succeeded",
        result.error || "Expected nested execution",
      );
      assert.equal(
        (await adapter.observe()).facts.result,
        task.parameters.name,
      );
      assert.throws(
        () =>
          runtime.registry.publish(parent.id, [
            result.id,
            result.id + "x",
            result.id + "y",
          ]),
        /published dependencies/,
      );
    }
    const imported = importWorkflowLibrary(library);
    assert.ok(
      [...imported.roots, ...imported.dependencies].every(
        (skill) => skill.status === "quarantined",
      ),
    );
    assert.throws(
      () => importWorkflowLibrary({ ...library, dependencies: [] }),
      /missing dependencies/,
    );
    const corrupted = structuredClone(library);
    corrupted.roots[0].hash = "forged";
    assert.throws(() => importWorkflowLibrary(corrupted), /hash mismatch/);
    assert.throws(
      () =>
        importWorkflowLibrary({
          schemaVersion: 1,
          roots: [],
          dependencies: [],
          extractions: [],
        }),
      /schema/,
    );
    assert.throws(
      () =>
        importWorkflowLibrary({
          ...library,
          extractions: [
            {
              ...library.extractions[0],
              methods: ["foreign.method", "another.foreign.method"],
            },
          ],
        }),
      /references/,
    );
    const unknown = structuredClone(demos);
    unknown[0].steps[0].label = "unknown";
    assert.throws(
      () => compileWorkflowLibrary(unknown),
      /failed demonstrations/,
    );
  } finally {
    await runtime.close();
  }
});
