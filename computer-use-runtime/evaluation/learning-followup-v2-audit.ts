import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { Store, canonical, hash } from "../src/storage/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { seedForm } from "../src/skills/index.js";
import { repairSkills } from "../src/learner/selector.js";
import { Controller } from "../src/learner/index.js";
import { productionContext } from "../src/learner/context.js";
import type { Observation } from "../src/contracts/index.js";

type Config = {
  root: string;
  directory: string;
  protocol: any;
  protocolBytes: Buffer;
  sourceBefore: Record<string, string>;
  protectedBefore: Record<string, string>;
  fingerprint: () => Record<string, string>;
};
function intervals(records: any[]) {
  const trained = records.filter((row) => row.method === "trained");
  const differences = trained.map((row) => {
    const other = records.find(
      (other) =>
        other.seed === row.seed &&
        other.episode === row.episode &&
        other.method === "initialized",
    );
    return {
      success: Number(row.success) - Number(other.success),
      observations: row.observations - other.observations,
    };
  });
  let random = 90210;
  const successes: number[] = [],
    observations: number[] = [];
  for (let sample = 0; sample < 2000; sample++) {
    let success = 0,
      observed = 0;
    for (let i = 0; i < differences.length; i++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const difference =
        differences[Math.floor((random / 4294967296) * differences.length)];
      success += difference.success;
      observed += difference.observations;
    }
    successes.push(success / differences.length);
    observations.push(observed / differences.length);
  }
  successes.sort((a, b) => a - b);
  observations.sort((a, b) => a - b);
  return {
    success95: [successes[50], successes[1949]],
    observations95: [observations[50], observations[1949]],
  };
}
export function metricsForHeads(
  records: any[],
  seed: number,
  model = "trained",
) {
  const rows = records.filter((row) => row.seed === seed),
    predictions = rows.map((row) => row.predictions[model]);
  const predicates = rows
    .flatMap((row, index) =>
      row.predicateTruth.map((truth: number, key: number) => ({
        truth,
        prediction: predictions[index].predicates[key],
      })),
    )
    .filter((row) => row.truth >= 0);
  const clarify = rows
    .map((row, index) => ({
      truth: row.recoveryTruth,
      prediction: predictions[index].recovery,
    }))
    .filter((row) => row.truth === 3);
  const outcomes = rows
    .map((row, index) => ({
      truth: row.outcomeTruth,
      mask: row.outcomeMask,
      prediction: predictions[index].outcome[0],
    }))
    .filter((row) => row.mask);
  const costs = rows
    .map((row, index) => ({
      truth: row.costTruth,
      mask: row.costMask,
      prediction: predictions[index].outcome[1],
    }))
    .filter((row) => row.mask);
  return {
    seed,
    model,
    episodes: rows.length,
    predicateAccuracy:
      predicates.filter((row) => row.prediction >= 0.5 === (row.truth === 1))
        .length / predicates.length,
    recoveryAccuracy:
      rows.filter(
        (row, index) => row.recoveryTruth === predictions[index].recovery,
      ).length / rows.length,
    clarificationRecall:
      clarify.filter((row) => row.prediction === 3).length / clarify.length,
    outcomeBrier:
      outcomes.reduce(
        (sum, row) => sum + (row.prediction - row.truth) ** 2,
        0,
      ) / outcomes.length,
    costMae:
      costs.reduce(
        (sum, row) => sum + Math.abs(row.prediction - row.truth),
        0,
      ) / costs.length,
    predicateLabels: predicates.length,
    clarificationLabels: clarify.length,
    knownOutcomeLabels: outcomes.length,
    knownCostLabels: costs.length,
  };
}
export async function auditFullHeads(config: Config) {
  const {
    root,
    directory,
    protocol,
    protocolBytes,
    sourceBefore,
    protectedBefore,
    fingerprint,
  } = config;
  if (existsSync(join(directory, "audit-sealed.json")))
    throw new Error("V2 protected final outcomes are sealed");
  const selectionBytes = readFileSync(join(directory, "selection.json")),
    selection = JSON.parse(selectionBytes.toString()),
    reports = JSON.parse(
      readFileSync(join(directory, "training.json"), "utf8"),
    );
  if (
    selection.status !== "PASS" ||
    selection.protocolHash !== hash(protocolBytes)
  )
    throw new Error("V2 candidate not selected under frozen protocol");
  for (const report of reports)
    if (
      selection.candidateHashes.find(
        (candidate: any) => candidate.seed === report.seed,
      )?.sha256 !== report.sha256 ||
      hash(
        readFileSync(
          join(directory, "models", String(report.seed), "trained.onnx"),
        ),
      ) !== report.sha256 ||
      report.trainManifestHash !==
        hash(readFileSync(join(directory, "train-manifest.json"))) ||
      report.validationManifestHash !==
        hash(readFileSync(join(directory, "validation-manifest.json")))
    )
      throw new Error("V2 selected model/data changed");
  const store = new Store(join(directory, "audit-store")),
    adapter = await new BrowserAdapter(store, "v2-final").start(),
    runtime = new Runtime(store, adapter);
  const skills = [seedForm(), ...repairSkills()],
    candidates = [...skills, { descriptor: [0, 0, 0, 1, 0, 0, 0, 0] }];
  for (const skill of skills) runtime.registry.put(skill);
  let captures = 0;
  const observe = adapter.observe.bind(adapter);
  adapter.observe = (signal?: AbortSignal) => {
    captures++;
    return observe(signal);
  };
  const records: any[] = [],
    heads: any[] = [];
  const role = (before: Observation) =>
    before.facts.dialog === true ? 2 : before.facts.closed === true ? 1 : 0;
  function task(name: string, desired: number, requester: string) {
    const value = structuredTask(
      "Set the display name in the authorized form",
      {
        host: adapter.host,
        session: adapter.session,
        identity: adapter.identity,
      },
      { name },
      skills[desired].id,
    );
    value.requester = requester;
    value.expected =
      desired === 0
        ? { result: name }
        : desired === 1
          ? { ready: true }
          : { dialog: false };
    return value;
  }
  try {
    for (const seed of protocol.seeds) {
      const trained = await Controller.load(
          join(directory, "models", String(seed), "trained.onnx"),
        ),
        initialized = await Controller.load(
          join(directory, "models", String(seed), "initialized.onnx"),
        ),
        v1 = await Controller.load(
          resolve(
            "evidence/learning-followup-v1/browser/models/" +
              seed +
              "/trained.onnx",
          ),
        );
      try {
        for (const method of protocol.methods)
          for (
            let episode = 0;
            episode < protocol.episodesPerMethodPerSeed;
            episode++
          ) {
            const name =
                "V2 final " +
                seed +
                " " +
                episode +
                " " +
                hash(hash(protocolBytes) + seed + ":" + episode).slice(0, 12),
              requester = "v2-final-" + seed + "-" + method + "-" + episode;
            await adapter.reset(
              ["ready", "closed", "dialog", "both"][episode % 4],
              episode % 3 === 0 ? "shift" : "base",
            );
            const start = performance.now(),
              capturesBefore = captures;
            let steps = 0,
              claimed = false;
            const runs: string[] = [],
              decisions: any[] = [];
            while (steps < 8 && performance.now() - start < 15000) {
              const before = await adapter.observe(),
                desired = role(before),
                contract = task(name, desired, requester),
                version = method === "v1_selection" ? 2 : 3;
              const context = productionContext(
                store,
                contract,
                before,
                Date.now() - (performance.now() - start),
                version,
              );
              const allowed = skills
                .map((skill, index) => ({ skill, index }))
                .filter(({ skill }) =>
                  skill.preconditions.every(
                    (predicate) => before.facts[predicate] === true,
                  ),
                )
                .map(({ index }) => index);
              let choice = desired,
                prediction;
              if (!["fixed", "without_compilation"].includes(method)) {
                const input =
                  method === "frozen_context"
                    ? new Float32Array(48)
                    : context.context;
                if (method === "frozen_context") {
                  input[24] = 1;
                  input[32] = 1;
                  input[33] = 0.5;
                  input[35] = 1;
                }
                prediction = await (
                  method === "initialized"
                    ? initialized
                    : method === "v1_selection"
                      ? v1
                      : trained
                ).rank(
                  before,
                  [...allowed.map((index) => candidates[index]), candidates[3]],
                  input,
                );
                choice =
                  prediction.index === allowed.length
                    ? 3
                    : allowed[prediction.index];
              }
              decisions.push({
                observationId: before.id,
                choice,
                context: Array.from(context.context),
                historyActionIds: context.previous.map(
                  (entry) => entry.action.id,
                ),
                prediction,
              });
              if (choice === 3) break;
              const execution = { ...contract, method: skills[choice].id };
              execution.budgets.steps = Math.max(1, 8 - steps);
              execution.budgets.deadlineMs = Math.max(
                1,
                15000 - Math.ceil(performance.now() - start),
              );
              runtime.submit(execution, execution.id);
              await runtime.execute(execution.id);
              runs.push(execution.id);
              steps += store
                .events(0, execution.id)
                .filter((event) => event.type === "requested").length;
              if (store.run(execution.id).status !== "succeeded") break;
              if (choice === 0) {
                claimed = true;
                break;
              }
            }
            const actual = await adapter.page.locator("#result").textContent(),
              success = actual === name;
            const row = {
              seed,
              method,
              episode,
              success,
              falseSuccess: claimed && !success,
              observations: captures - capturesBefore,
              steps,
              elapsedMs: performance.now() - start,
              generativeCalls: 0,
              runs,
              decisions,
              evidenceLevel: "resettable live browser fixture",
              independentEvaluator: "Separate public result DOM read",
            };
            records.push(row);
            appendFileSync(
              join(directory, "episodes.jsonl"),
              JSON.stringify(row) + "\n",
            );
            if (episode === protocol.episodesPerMethodPerSeed - 1)
              console.log(
                JSON.stringify({
                  seed,
                  method,
                  completed: episode + 1,
                  successes: records.filter(
                    (row) =>
                      row.seed === seed && row.method === method && row.success,
                  ).length,
                }),
              );
          }
        for (
          let episode = 0;
          episode < protocol.headEpisodesPerSeed;
          episode++
        ) {
          const started = performance.now();
          const scenario = episode % 5,
            desired = scenario === 1 ? 1 : scenario === 2 ? 2 : 0,
            missing = scenario === 4,
            proposal = scenario === 3 ? 1 : missing ? 3 : desired;
          await adapter.reset(
            scenario === 1
              ? "closed"
              : scenario === 2
                ? "dialog"
                : scenario === 4
                  ? ["ready", "closed", "dialog", "both"][
                      Math.floor(episode / 5) % 4
                    ]
                  : "ready",
            episode % 2 ? "shift" : "base",
          );
          const name = "V2 head final " + seed + " " + episode,
            contract = task(name, desired, "v2-head-" + seed + "-" + episode);
          if (missing) {
            contract.parameters = {};
            contract.unresolved = ["The required display name is missing"];
            runtime.submit(contract, contract.id);
          }
          const before = await adapter.observe(),
            context = productionContext(
              store,
              contract,
              before,
              undefined,
              3,
            ).context,
            predictions: Record<string, unknown> = {};
          for (const [method, controller] of [
            ["trained", trained],
            ["initialized", initialized],
          ] as const) {
            const prediction = await controller.rank(
              before,
              [candidates[proposal]],
              context,
            );
            predictions[method] = {
              predicates: prediction.predicates.map(
                (value) => 1 / (1 + Math.exp(-value)),
              ),
              recovery: prediction.recovery.indexOf(
                Math.max(...prediction.recovery),
              ),
              outcome: prediction.outcome,
              latencyMs: prediction.latencyMs,
            };
          }
          let outcome = 0,
            cost = 0,
            mask = 0;
          let finalObservation: Observation | undefined,
            executionRunId: string | undefined;
          if (!missing) {
            const execution = { ...contract, method: skills[proposal].id };
            execution.budgets.deadlineMs = Math.max(
              1,
              15000 - Math.ceil(performance.now() - started),
            );
            runtime.submit(execution, execution.id);
            await runtime.execute(execution.id);
            const after = await adapter.observe();
            finalObservation = after;
            executionRunId = execution.id;
            outcome = Number(
              Object.entries(contract.expected).every(
                ([key, value]) => after.facts[key] === value,
              ),
            );
            cost =
              store
                .events(0, execution.id)
                .filter((event) => event.type === "requested").length / 8;
            mask = Number(
              !["uncertain", "reconciliation_required"].includes(
                store.run(execution.id).status,
              ) &&
                store
                  .events(0, execution.id)
                  .every(
                    (event) =>
                      event.type !== "experience" ||
                      ["acknowledged", "effect_verified"].includes(
                        (event.data as any).receipt?.phase,
                      ),
                  ),
            );
          } else if (store.run(contract.id).status !== "awaiting_input")
            throw new Error(
              "Final incomplete contract did not reach awaiting_input",
            );
          const row = {
            seed,
            episode,
            scenario,
            observationId: before.id,
            before,
            contract,
            finalObservation,
            executionRunId,
            runtimeStatus: store.run(executionRunId || contract.id).status,
            context: Array.from(context),
            proposal,
            proposedDescriptor: candidates[proposal].descriptor,
            predicateTruth: ["ready", "closed", "dialog"].map((key) =>
              typeof before.facts[key] === "boolean"
                ? Number(before.facts[key])
                : -1,
            ),
            recoveryTruth: missing ? 3 : role(before),
            outcomeTruth: outcome,
            outcomeMask: missing ? 0 : 1,
            costTruth: cost,
            costMask: mask,
            predictions,
            elapsedMs: performance.now() - started,
            generativeCalls: 0,
            independentEvaluator: missing
              ? "Actual missing typed input and awaiting_input runtime state"
              : "Independent public output after actual proposed macro",
            policyUsesPostActionData: false,
          };
          heads.push(row);
          appendFileSync(
            join(directory, "heads.jsonl"),
            JSON.stringify(row) + "\n",
          );
        }
      } finally {
        await trained.close();
        await initialized.close();
        await v1.close();
      }
    }
    const paired = intervals(records),
      sourceAfter = fingerprint(),
      protectedAfter = Object.fromEntries(
        protocol.protected.map((path: string) => [
          path,
          hash(readFileSync(path)),
        ]),
      );
    const headMetrics = protocol.seeds.map((seed: number) =>
        metricsForHeads(heads, seed),
      ),
      headPass = headMetrics.every(
        (metric: any) =>
          metric.predicateAccuracy >= 0.95 &&
          metric.recoveryAccuracy >= 0.9 &&
          metric.clarificationRecall >= 0.9 &&
          metric.outcomeBrier <= 0.15 &&
          metric.costMae <= 0.15,
      );
    const safe =
      records.every(
        (row) => !row.falseSuccess && row.steps <= 8 && row.elapsedMs <= 15000,
      ) &&
      canonical(sourceBefore) === canonical(sourceAfter) &&
      canonical(protectedBefore) === canonical(protectedAfter);
    const benefit =
      safe &&
      (paired.success95[0] > 0 ||
        (paired.observations95[1] < 0 && paired.success95[0] >= -0.02));
    const report = {
      schemaVersion: 1,
      id: protocol.id + "-browser",
      track: "browser",
      scope:
        "Controlled workbench full advisory heads; actual corrections and incomplete contracts",
      protocolHash: hash(protocolBytes),
      episodes: records.length,
      grouped: protocol.methods.map((method: string) => ({
        method,
        episodes: records.filter((row) => row.method === method).length,
        successes: records.filter((row) => row.method === method && row.success)
          .length,
        observationsMean:
          records
            .filter((row) => row.method === method)
            .reduce((sum, row) => sum + row.observations, 0) / 300,
      })),
      falseSuccess: records.filter((row) => row.falseSuccess).length,
      paired,
      learningBenefit: benefit ? "PASS" : "FAIL",
      fullHeads: headPass ? "PASS" : "FAIL",
      headMetrics,
      initializedHeadMetrics: protocol.seeds.map((seed: number) =>
        metricsForHeads(heads, seed, "initialized"),
      ),
      headsHash: hash(readFileSync(join(directory, "heads.jsonl"))),
      models: reports,
      learnedCapabilities: [
        "selection",
        "predicates",
        "recovery",
        "clarification",
        "outcome_cost",
      ],
      operational: JSON.parse(
        readFileSync(join(directory, "operational.json"), "utf8"),
      ),
      conditionalParity: JSON.parse(
        readFileSync(join(directory, "conditional-parity.json"), "utf8"),
      ),
      skillTemplates: skills.map((skill) =>
        hash(canonical({ ...skill, hash: "", compatibility: [] })),
      ),
      candidateSelectionHash: hash(selectionBytes),
      sourceBefore,
      sourceAfter,
      sourceStable: canonical(sourceBefore) === canonical(sourceAfter),
      protectedBefore,
      protectedAfter,
      libraryBenefit:
        "Separate library study; this controlled comparison holds primitive macro library fixed",
      nonClaims: protocol.nonClaims,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(
      join(directory, "results.json"),
      JSON.stringify(report, null, 2),
      { flag: "wx" },
    );
    const keyPath = join(root, ".evaluator.key");
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    const key = readFileSync(keyPath);
    const seal = {
      protocolHash: hash(protocolBytes),
      resultsHash: hash(readFileSync(join(directory, "results.json"))),
      episodesHash: hash(readFileSync(join(directory, "episodes.jsonl"))),
      headsHash: report.headsHash,
      sourceStable: report.sourceStable,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(
      join(directory, "audit-sealed.json"),
      JSON.stringify(
        {
          ...seal,
          signature: createHmac("sha256", key)
            .update(canonical(seal))
            .digest("hex"),
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    console.log(
      JSON.stringify({
        learningBenefit: report.learningBenefit,
        fullHeads: report.fullHeads,
        paired,
        headMetrics,
        sourceStable: report.sourceStable,
      }),
    );
    if (!benefit || !headPass) process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}
