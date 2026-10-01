import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { NativeClient, WindowsAdapter } from "../src/adapters/native.js";
import { structuredTask } from "../src/compiler/intent.js";
import { seal, seedForm } from "../src/skills/index.js";
import { writeFileSync } from "node:fs";
const probe = new NativeClient();
const w = (await probe.call("windows")).find((w: any) =>
  w.title.endsWith(" - Paint"),
);
await probe.close();
const store = new Store(".data/save-dialog-" + Date.now()),
  adapter = await new WindowsAdapter(store).start(w.handle),
  runtime = new Runtime(store, adapter);
try {
  const skill = seal({
    ...seedForm(),
    id: "save-dialog",
    inputs: {},
    compatibility: [adapter.identity],
    capabilities: ["key"],
    effects: ["save"],
    preconditions: [],
    machine: {
      initial: "open",
      states: [
        {
          id: "open",
          steps: [
            {
              id: "open",
              operation: "key",
              args: { key: "F12" },
              scope: "save",
            },
            {
              id: "wait",
              operation: "wait",
              args: {},
              scope: "save",
              waitMs: 600,
            },
          ],
          monitor: ["focused"],
        },
      ],
    },
  });
  runtime.registry.put(skill);
  const task = structuredTask(
    "Open the Save As dialog to select PNG for the explicitly requested new artifact",
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    {},
    skill.id,
  );
  task.effects = ["save"];
  task.expected = { ownedDialog: true };
  runtime.submit(task, task.id);
  await runtime.execute(task.id);
  const resolved = await adapter.client.call("resolve_target", {
    handle: w.handle,
  });
  const elements = await adapter.client.call("accessibility", {
    handle: resolved.handle,
  });
  writeFileSync(
    "evidence/save-dialog.json",
    JSON.stringify(
      { window: w, resolved, elements, run: store.run(task.id) },
      null,
      2,
    ),
  );
  console.log(
    elements.filter(
      (e: any) => !e.offscreen && [50003, 50004, 50000].includes(e.controlType),
    ),
  );
} finally {
  await runtime.close();
}
