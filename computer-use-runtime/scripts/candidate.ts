import { join, resolve } from "node:path";
import { trainingPython } from "../src/learner/python.js";
import {
  prepareCandidate,
  candidateOperation,
} from "../src/development/candidate.js";

const command = process.argv[2] || "prepare",
  requested = process.argv[3],
  root = process.cwd();
if (command === "prepare") console.log(prepareCandidate(root));
else if ((command === "check" || command === "run") && requested) {
  const { report, output } = await candidateOperation(
    root,
    requested,
    command,
    async (guard, report) => {
      const test = guard.child(
        process.execPath,
        [
          "--import",
          "tsx",
          "--test",
          "--test-reporter=tap",
          join(guard.root, "tests/promotion.test.ts"),
        ],
        60000,
        true,
      );
      report.tests = test;
      if (
        test.exitCode !== 0 ||
        test.error ||
        test.protectionError ||
        !/# tests [1-9]\d*\b/.test(test.stdout) ||
        !/# fail 0\b/.test(test.stdout) ||
        !/# skipped 0\b/.test(test.stdout) ||
        !/# cancelled 0\b/.test(test.stdout) ||
        !/# todo 0\b/.test(test.stdout)
      )
        throw new Error(
          "Candidate test failed or did not complete non-skipped promotion tests: " +
            (test.protectionError || test.error || "exit " + test.exitCode),
        );
      if (command === "check") return;
      const training = guard.child(trainingPython(), [
        join(guard.path, "learner/train.py"),
      ]);
      report.training = training;
      if (training.exitCode !== 0 || training.error || training.protectionError)
        throw new Error(
          "Candidate training failed: " +
            (training.protectionError ||
              training.error ||
              "exit " + training.exitCode),
        );
      guard.verify();
      const [
        { Store },
        { BrowserAdapter },
        { Runtime },
        { seedForm },
        { Controller },
        { structuredTask },
      ] = await Promise.all([
        import("../src/storage/index.js"),
        import("../src/adapters/browser.js"),
        import("../src/runtime/index.js"),
        import("../src/skills/index.js"),
        import("../src/learner/index.js"),
        import("../src/compiler/intent.js"),
      ]);
      const store = new Store(join(guard.path, "runtime-check"));
      let adapter: InstanceType<typeof BrowserAdapter> | undefined,
        runtime: InstanceType<typeof Runtime> | undefined,
        controller: Awaited<ReturnType<typeof Controller.load>> | undefined;
      try {
        adapter = new BrowserAdapter(store);
        await adapter.start();
        runtime = new Runtime(store, adapter);
        runtime.registry.put(seedForm());
        controller = await Controller.load(
          join(guard.path, "models/17/trained.onnx"),
        );
        report.prediction = await controller.rank(await adapter.observe(), [
          seedForm(),
        ]);
        const task = structuredTask(
          "Candidate runtime exercise",
          {
            host: adapter.host,
            session: adapter.session,
            identity: adapter.identity,
          },
          { name: "Isolated candidate check" },
        );
        runtime.submit(task, task.id);
        await runtime.execute(task.id);
        report.run = store.run(task.id);
        if (store.run(task.id).status !== "succeeded")
          throw new Error(
            "Candidate runtime exercise did not independently succeed",
          );
        report.trainingReport = join(guard.path, "evidence/training.json");
      } catch (error) {
        report.errors.push(
          "Candidate runtime exercise failed: " +
            (error instanceof Error ? error.message : String(error)),
        );
      } finally {
        const cleanups = await Promise.allSettled([
          controller?.close(),
          runtime ? runtime.close() : adapter?.close(),
        ]);
        if (!runtime)
          try {
            store.close();
          } catch (error) {
            report.errors.push(
              "Candidate store cleanup failed: " +
                (error instanceof Error ? error.message : String(error)),
            );
          }
        const failed = cleanups.filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        report.cleanupErrors = failed.map((result) =>
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
        );
        if (failed.length)
          throw new AggregateError(
            failed.map((result) => result.reason),
            "Candidate runtime cleanup failed",
          );
      }
    },
  );
  console.log(JSON.stringify({ ...report, reportPath: resolve(output) }));
  if (report.status !== "PASS") process.exitCode = 1;
} else
  throw new Error(
    "Usage: tsx scripts/candidate.ts prepare | check .candidates/<id> | run .candidates/<id>",
  );
