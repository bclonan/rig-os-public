import { Store } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { NativeClient, WindowsAdapter } from "../src/adapters/native.js";
import { structuredTask } from "../src/compiler/intent.js";
import { seal, seedForm } from "../src/skills/index.js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomInt } from "node:crypto";
import { fact } from "../src/predicates/index.js";
const path = resolve(
  "evidence/paint-square-" + randomInt(100000, 999999) + ".png",
);
const probe = new NativeClient();
const w = (await probe.call("windows")).find((w: any) =>
  w.title.endsWith(" - Paint"),
);
await probe.close();
const store = new Store(".data/png-save-" + Date.now()),
  adapter = await new WindowsAdapter(store, false).start(w.handle),
  runtime = new Runtime(store, adapter, {
    verify(_t, o) {
      const png =
        existsSync(path) &&
        readFileSync(path)
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return [
        fact(
          { ...o, facts: { ...o.facts, pngSaved: png } },
          "pngSaved",
          true,
          "completion",
        ),
      ];
    },
  });
const result: any = {
  path,
  status: "NOT RUN",
  level: "native desktop",
  explicitSave: true,
};
try {
  const o = await adapter.observe();
  if (!o.facts.ownedDialog)
    throw new Error(
      "Run evaluation/save-dialog.ts to open the owned Save As dialog",
    );
  const skill = seal({
    ...seedForm(),
    id: "png-save",
    inputs: {},
    compatibility: [adapter.identity],
    capabilities: ["select", "fill", "invoke"],
    effects: ["save"],
    preconditions: ["ownedDialog"],
    machine: {
      initial: "save",
      states: [
        {
          id: "save",
          steps: [
            {
              id: "format",
              operation: "select",
              scope: "save",
              args: { locator: "FileTypeControlHost", value: "PNG (*.png)" },
            },
            {
              id: "name",
              operation: "fill",
              scope: "save",
              args: { locator: "FileNameControlHost", value: path },
            },
            {
              id: "save",
              operation: "invoke",
              scope: "save",
              args: { locator: "1" },
            },
            {
              id: "wait",
              operation: "wait",
              scope: "save",
              args: {},
              waitMs: 800,
            },
          ],
          monitor: ["focused"],
        },
      ],
    },
  });
  runtime.registry.put(skill);
  const t = structuredTask(
    "Save the prescribed square as a new PNG file at " + path,
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    {},
    skill.id,
  );
  t.effects = ["save"];
  t.expected = { pngSaved: true };
  t.budgets.deadlineMs = 30000;
  runtime.submit(t, t.id);
  await runtime.execute(t.id);
  result.run = store.run(t.id);
  result.events = store.events(0, t.id);
  result.status =
    result.run.status === "succeeded" ? "SAVED_PENDING_IMAGE_CHECK" : "FAIL";
} catch (e) {
  result.status = "FAIL";
  result.reason = String(e);
} finally {
  await runtime.close();
  writeFileSync("evidence/paint-png.json", JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      status: result.status,
      reason: result.reason,
      error: result.run?.error,
      path,
    }),
  );
}
