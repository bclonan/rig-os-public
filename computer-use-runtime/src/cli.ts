import { trainingPython } from "./learner/python.js";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { Store } from "./storage/index.js";
import { Runtime } from "./runtime/index.js";
import { BrowserAdapter } from "./adapters/browser.js";
import { seedForm } from "./skills/index.js";
import { startService } from "./service/launcher.js";
import {
  serviceConfig,
  readServiceToken,
  readOwner,
  processAlive,
  probeService,
  stopService,
  copyToken,
  openConsole,
} from "./service/lifecycle.js";
import { OllamaProvider } from "./providers/index.js";
import { Recorder, type Demonstration } from "./recorder/index.js";
import { compileDemonstrations } from "./compiler/experience.js";
import { structuredTask } from "./compiler/intent.js";
import { schemas } from "./contracts/index.js";
import { ModelRegistry } from "./learner/index.js";
import { AdaptiveSelector } from "./learner/selector.js";
import { exportDataset, importDataset } from "./recorder/bundle.js";
import { previewSkillMigration } from "./skills/bundle.js";
async function main() {
  const [command = "doctor", ...args] = process.argv.slice(2);
  mkdirSync("evidence", { recursive: true });
  if (
    ["start", "stop", "restart", "status", "token", "open"].includes(command)
  ) {
    const config = serviceConfig();
    if (command === "token") {
      const token = readServiceToken(config);
      if (args.includes("--copy")) {
        copyToken(token);
        console.log("Token copied to the clipboard.");
      } else console.log(token);
    } else if (command === "status") {
      const status = await probeService(config);
      const owner = readOwner(config.root);
      if (status)
        console.log(
          `Running at ${config.url}, process ${status.pid}. Active tasks: ${status.activeTasks}.\nToken: npm run token\nStop: npm stop`,
        );
      else if (owner && processAlive(owner)) {
        console.error(
          `Process ${owner} owns the store, but the service is not ready at ${config.url}. Check its terminal.`,
        );
        process.exitCode = 1;
      } else
        console.log(
          `Runtime is stopped. Start with npm start.\nSaved data: ${config.root}`,
        );
    } else if (command === "open") {
      if (!(await probeService(config)))
        throw new Error("The runtime is not ready. Run npm start first.");
      await openConsole(config.url);
    } else if (command === "stop") {
      console.log(
        (await stopService(config))
          ? "Runtime stopped. Start again with npm start."
          : "Runtime is already stopped.",
      );
    } else {
      if (command === "restart") await stopService(config);
      await startService(config, args);
    }
  } else if (command === "doctor") {
    const result = {
      node: process.version,
      platform: process.platform,
      host: hostname(),
      core: process.versions.node.startsWith("24."),
      nativeBinary: existsSync("native/target/release/computer-use-native.exe"),
      python: spawnSync(
        trainingPython(),
        [
          "-c",
          "import torch,onnxruntime; print(torch.__version__,onnxruntime.__version__)",
        ],
        { encoding: "utf8", windowsHide: true },
      ).stdout?.trim(),
      ollama: await OllamaProvider.discover(),
      trainedModels: existsSync("models") ? readdirSync("models") : [],
      console: existsSync("dist/console/index.html"),
      networkRequiredForKnownSkills: false,
      hostApplicationsRequired: false,
    };
    writeFileSync("evidence/doctor.json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "schemas") {
    mkdirSync("schemas", { recursive: true });
    for (const [name, schema] of Object.entries(schemas))
      writeFileSync(
        `schemas/${name}.v1.json`,
        JSON.stringify(
          {
            $schema: "http://json-schema.org/draft-07/schema#",
            $id: `urn:computer-use-runtime:${name}:1`,
            ...schema,
          },
          null,
          2,
        ),
      );
    console.log("Wrote version 1 schemas");
  } else if (
    ["train", "evaluate", "verify-native", "benchmark-smoke"].includes(command)
  ) {
    const commands: Record<string, [string, string[]]> = {
      train: [trainingPython(), ["learner/train.py"]],
      evaluate: [process.execPath, ["--import", "tsx", "evaluation/audit.ts"]],
      "verify-native": [
        process.execPath,
        ["--import", "tsx", "evaluation/native.ts"],
      ],
      "benchmark-smoke": [
        process.execPath,
        ["--import", "tsx", "evaluation/benchmarks.ts"],
      ],
    };
    const [exe, argv] = commands[command];
    const r = spawnSync(exe, argv, { stdio: "inherit", windowsHide: true });
    if (r.error) throw new Error(`Cannot start ${command}: ${r.error.message}`);
    process.exitCode = r.status ?? 1;
  } else {
    const root = process.env.CUR_DATA || ".data/service";
    let store: Store | undefined;
    let adapter: BrowserAdapter | undefined;
    let selector: AdaptiveSelector | undefined;
    let runtime: Runtime | undefined;
    let operationError: unknown;
    try {
      store = new Store(root);
      adapter = new BrowserAdapter(store);
      await adapter.start(!args.includes("--headed"));
      selector = new AdaptiveSelector(store, adapter.capabilities);
      runtime = new Runtime(
        store,
        adapter,
        undefined,
        undefined,
        selector.select.bind(selector),
      );
      if (!runtime.registry.list().length) runtime.registry.put(seedForm());
      await runtime.recover();
      if (command === "record") {
        const recorder = new Recorder(store);
        for (const name of args.length
          ? args
          : ["Recorded Alder 1", "Recorded Birch 2", "Recorded Cedar 3"]) {
          await adapter.reset();
          const task = structuredTask(
            "Set display name",
            {
              host: adapter.host,
              session: adapter.session,
              identity: adapter.identity,
            },
            { name },
          );
          runtime.submit(task, task.id);
          await runtime.execute(task.id);
          const demo = recorder.capture(task.id);
          console.log(
            JSON.stringify({
              id: demo.id,
              verified: demo.verified,
              steps: demo.steps.length,
            }),
          );
        }
        writeFileSync(
          "evidence/demonstrations.json",
          JSON.stringify(recorder.export(), null, 2),
        );
      } else if (command === "compile") {
        const skill = compileDemonstrations(
          store.list<Demonstration>("demonstrations"),
        );
        runtime.registry.put(skill);
        mkdirSync("skills", { recursive: true });
        writeFileSync("skills/draft.json", JSON.stringify(skill, null, 2));
        console.log(
          JSON.stringify({
            id: skill.id,
            status: skill.status,
            hash: skill.hash,
          }),
        );
      } else if (command === "skill-migrate") {
        const source = readFileSync(args[0]);
        const result = args.includes("--preview")
          ? {
              bundle: previewSkillMigration(
                source,
                { from: 1, to: 2 },
                runtime.registry,
              ),
              preview: true,
            }
          : runtime.registry.migrate(source);
        writeFileSync(
          args[1] || "skill-bundle-v2.json",
          JSON.stringify(result.bundle, null, 2),
        );
        console.log(JSON.stringify(result));
      } else if (command === "bundle-export") {
        const bundle = runtime.registry.exportBundle(args[0] || "form.seed");
        writeFileSync(
          args[1] || "skill-bundle-v2.json",
          JSON.stringify(bundle, null, 2),
        );
        console.log("Exported version 2 bundle " + bundle.root.id);
      } else if (command === "bundle-import") {
        console.log(
          JSON.stringify(runtime.registry.importBundle(readFileSync(args[0]))),
        );
      } else if (command === "export") {
        const skill = runtime.registry.get(args[0] || "form.seed");
        writeFileSync(
          args[1] || "skill-export.json",
          JSON.stringify(skill, null, 2),
        );
        console.log("Exported " + skill.id);
      } else if (command === "import") {
        console.log(
          JSON.stringify(
            runtime.registry.import(JSON.parse(readFileSync(args[0], "utf8"))),
          ),
        );
      } else if (command === "rollback") {
        console.log(JSON.stringify(new ModelRegistry(store).rollback()));
      } else if (command === "dataset-export") {
        writeFileSync(
          args[0] || "evidence/dataset-bundle.json",
          JSON.stringify(exportDataset(store)),
        );
        console.log("Portable image dataset exported");
      } else if (command === "dataset-import") {
        console.log(
          JSON.stringify(
            importDataset(store, JSON.parse(readFileSync(args[0], "utf8"))),
          ),
        );
      } else if (command === "activate") {
        const models = new ModelRegistry(store);
        const seed = Number(args[0] || 17);
        models.register("owned-" + seed, `models/${seed}/trained.onnx`, seed);
        console.log(JSON.stringify(models.activate("owned-" + seed)));
      } else if (command === "evidence-export") {
        const manifest = {
          version: 1,
          runs: store.runs(),
          events: store
            .runs()
            .flatMap((run) => store!.events(0, run.id))
            .sort((a, b) => a.seq - b.seq),
          artifacts: readdirSync(resolve(store.root, "artifacts")).map(
            (id) => ({ id, bytes: store!.artifactRead(id).length }),
          ),
        };
        writeFileSync(
          args[0] || "evidence/export.json",
          JSON.stringify(manifest, null, 2),
        );
        console.log("Evidence manifest exported");
      } else throw new Error("Unknown command " + command);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      const errors: unknown[] = [];
      const close = async (operation: () => unknown | Promise<unknown>) => {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      };
      await close(() => selector?.close());
      let runtimeClosed = false;
      if (runtime)
        await close(async () => {
          await runtime!.close();
          runtimeClosed = true;
        });
      if (!runtimeClosed) {
        await close(() => adapter?.close());
        await close(() => store?.close());
      }
      if (errors.length)
        throw new AggregateError(
          operationError === undefined ? errors : [operationError, ...errors],
          "Offline command cleanup failed: " +
            [operationError, ...errors]
              .filter((error) => error !== undefined)
              .map(String)
              .join("; "),
        );
    }
  }
}
await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
