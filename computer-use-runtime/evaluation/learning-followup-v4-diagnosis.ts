import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, hash } from "../src/storage/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { seedForm } from "../src/skills/index.js";
import { repairSkills } from "../src/learner/selector.js";
import { Controller } from "../src/learner/index.js";
import { productionContext } from "../src/learner/context.js";
import { screenshotTensor } from "../src/learner/image.js";

const directory = resolve(
  "evidence/learning-followup-v4-diagnosis/" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    "-" +
    randomUUID(),
);
mkdirSync(directory, { recursive: true });
const store = new Store(join(directory, "store"));
const adapter = await new BrowserAdapter(
  store,
  "fresh-crossed-development",
).start();
const runtime = new Runtime(store, adapter);
const skills = [seedForm(), ...repairSkills()];
for (const skill of skills) runtime.registry.put(skill);
const paths = [17, 41, 73].map((seed) =>
  resolve(
    "evidence/learning-followup-v3/browser/models/" + seed + "/trained.onnx",
  ),
);
const beforeHashes = paths.map((path) => hash(readFileSync(path)));
const controllers = await Promise.all(
  paths.map((path) => Controller.load(path)),
);
const rows: any[] = [];
try {
  for (const state of ["ready", "closed", "dialog", "both"])
    for (const layout of ["base", "shift"])
      for (let proposal = 0; proposal < 3; proposal++) {
        await adapter.reset(state, layout);
        const name = "Fresh diagnostic " + randomUUID();
        const task = structuredTask(
          "Set the display name in the authorized form",
          {
            host: adapter.host,
            session: adapter.session,
            identity: adapter.identity,
          },
          { name },
          skills[proposal].id,
        );
        task.requester = "fresh-development-" + randomUUID();
        task.expected = { result: name };
        const before = await adapter.observe();
        const context = productionContext(
          store,
          task,
          before,
          undefined,
          4,
        ).context;
        const bytes = store.artifactRead(before.image!);
        const imagePath = join(directory, before.image + ".png");
        if (!existsSync(imagePath))
          writeFileSync(imagePath, bytes, { flag: "wx" });
        const pixels = screenshotTensor(bytes);
        const predictions = await Promise.all(
          controllers.map((controller) =>
            controller.rank(before, [skills[proposal]], context, pixels),
          ),
        );
        runtime.submit(task, task.id);
        await runtime.execute(task.id);
        const after = await adapter.observe();
        const events = store.events(0, task.id);
        rows.push({
          state,
          layout,
          proposal,
          before,
          after,
          contract: task,
          context: Array.from(context),
          imagePath,
          imageSha256: hash(bytes),
          predictions,
          independentSuccess: after.facts.result === name,
          runtimeStatus: store.run(task.id).status,
          receipts: events
            .filter((event) => event.type === "experience")
            .map((event) => (event.data as any).receipt),
          requested: events.filter((event) => event.type === "requested")
            .length,
        });
        appendFileSync(
          join(directory, "rows.jsonl"),
          JSON.stringify(rows[rows.length - 1]) + "\n",
        );
      }
  const metrics = [17, 41, 73].map((seed, index) => ({
    seed,
    episodes: rows.length,
    predicateAccuracy:
      rows.reduce(
        (sum, row) =>
          sum +
          ["ready", "closed", "dialog"].filter(
            (key, k) =>
              row.predictions[index].predicates[k] > 0 ===
              row.before.facts[key],
          ).length,
        0,
      ) /
      (3 * rows.length),
    outcomeBrier:
      rows.reduce(
        (sum, row) =>
          sum +
          (row.predictions[index].outcome[0] -
            Number(row.independentSuccess)) **
            2,
        0,
      ) / rows.length,
    perState: ["ready", "closed", "dialog", "both"].map((state) => ({
      state,
      labels: rows.filter((row) => row.state === state).length,
      predicateAccuracy:
        rows
          .filter((row) => row.state === state)
          .reduce(
            (sum, row) =>
              sum +
              ["ready", "closed", "dialog"].filter(
                (key, k) =>
                  row.predictions[index].predicates[k] > 0 ===
                  row.before.facts[key],
              ).length,
            0,
          ) / 18,
    })),
  }));
  const report = {
    schemaVersion: 1,
    scope:
      "Fresh crossed development diagnosis with unchanged V3 models, no optimization or protected final data",
    episodes: rows.length,
    metrics,
    modelPaths: paths,
    modelHashesBefore: beforeHashes,
    modelHashesAfter: paths.map((path) => hash(readFileSync(path))),
    rows,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(
    join(directory, "results.json"),
    JSON.stringify(report, null, 2),
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      directory,
      metrics,
      actualSuccesses: rows.filter((row) => row.independentSuccess).length,
      modelBytesUnchanged:
        JSON.stringify(report.modelHashesBefore) ===
        JSON.stringify(report.modelHashesAfter),
    }),
  );
} finally {
  await Promise.all(controllers.map((controller) => controller.close()));
  await runtime.close();
}
