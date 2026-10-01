import { appendFileSync, existsSync, readFileSync } from "node:fs";
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
import { screenshotTensor } from "../src/learner/image.js";
import { applicableProgram } from "../src/learner/descriptor.js";
import {
  finalizeFollowupAudit,
  verifiedFollowupSourceAliases,
} from "../src/learner/finalization.js";
import { followupTrainingProvenance } from "../src/learner/portable-inputs.js";
import {
  browserProgramBank,
  completeFormProgram,
} from "./learning-followup-v4-bank.js";

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

export function visualMetrics(records: any[], seed: number) {
  const rows = records.filter((row) => row.seed === seed);
  const accuracy = (row: any, condition: string) =>
    row.predicateTruth.filter(
      (truth: number, index: number) =>
        truth >= 0 &&
        row.ablations[condition].predicates[index] >= 0.5 === (truth === 1),
    ).length / row.predicateTruth.filter((truth: number) => truth >= 0).length;
  const mean = (condition: string) =>
    rows.reduce((sum, row) => sum + accuracy(row, condition), 0) / rows.length;
  const differences = rows.map(
    (row) => accuracy(row, "normal") - accuracy(row, "image_zero"),
  );
  let random = 90210;
  const samples = [];
  for (let sample = 0; sample < 2000; sample++) {
    let total = 0;
    for (let index = 0; index < rows.length; index++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      total += differences[Math.floor((random / 4294967296) * rows.length)];
    }
    samples.push(total / rows.length);
  }
  samples.sort((a, b) => a - b);
  return {
    seed,
    episodes: rows.length,
    normalAccuracy: mean("normal"),
    imageZeroAccuracy: mean("image_zero"),
    contextZeroAccuracy: mean("context_zero"),
    bothZeroAccuracy: mean("both_zero"),
    imageBenefit:
      differences.reduce((sum, value) => sum + value, 0) / rows.length,
    imageBenefit95: [samples[50], samples[1949]],
  };
}
export async function auditFullHeads(config: Config) {
  const {
    root,
    directory,
    protocol,
    protocolBytes,
    sourceBefore: currentSourceBefore,
    protectedBefore,
    fingerprint: currentFingerprint,
  } = config;
  if (existsSync(join(directory, "audit-sealed.json")))
    throw new Error("V4 protected final outcomes are sealed");
  const selectionBytes = readFileSync(join(directory, "selection.json")),
    selection = JSON.parse(selectionBytes.toString()),
    reports = JSON.parse(
      readFileSync(join(directory, "training.json"), "utf8"),
    );
  if (
    selection.status !== "PASS" ||
    selection.protocolHash !== hash(protocolBytes)
  )
    throw new Error("V4 candidate not selected under frozen protocol");
  // Admission precedes every Store, adapter and model load. Historical training
  // bytes are evidence only; current executable source is never remapped.
  await verifiedFollowupSourceAliases(directory, currentSourceBefore);
  const trainingProvenance = followupTrainingProvenance(
    directory,
    currentSourceBefore,
  );
  const originBindings =
    "origin" in trainingProvenance
      ? Object.fromEntries(
          trainingProvenance.origin.files.map((file) => [
            file.localPath,
            file.sha256,
          ]),
        )
      : {};
  const sourceBefore = { ...currentSourceBefore, ...originBindings };
  const fingerprint = () => {
    const current = currentFingerprint();
    if (
      canonical(followupTrainingProvenance(directory, current)) !==
      canonical(trainingProvenance)
    )
      throw new Error(
        "V4 training provenance: local origin or selected artifacts changed during audit",
      );
    return { ...current, ...originBindings };
  };
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
      throw new Error("V4 selected model/data changed");
  const store = new Store(join(directory, "audit-store"));
  const adapter = new BrowserAdapter(store, "v4-final");
  let ownedRuntime: Runtime | undefined;
  try {
    await adapter.start();
    const runtime = new Runtime(store, adapter);
    ownedRuntime = runtime;
    const bank = browserProgramBank(),
      skills = bank.programs,
      candidates = [...bank.descriptors, bank.abstention],
      basics = [seedForm(), ...repairSkills()];
    for (const skill of bank.all) runtime.registry.put(skill);
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
        protocol.goals.final[desired % 3][0],
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
      const v2 = await Controller.load(
        resolve(
          "evidence/learning-followup-v2/browser/models/" +
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
                "V4 final " +
                seed +
                " " +
                episode +
                " " +
                hash(hash(protocolBytes) + seed + ":" + episode).slice(0, 12),
              requester = "v4-final-" + seed + "-" + method + "-" + episode;
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
            const legacy = [
              "without_compilation",
              "v1_selection",
              "v2_public_facts",
            ].includes(method);
            while (steps < 8 && performance.now() - start < 15000) {
              const before = await adapter.observe(),
                desired = legacy ? role(before) : 0,
                contract = task(name, desired, requester),
                version =
                  method === "v1_selection"
                    ? 2
                    : method === "v2_public_facts"
                      ? 3
                      : 4;
              if (legacy)
                contract.goal = "Set the display name in the authorized form";
              const context = productionContext(
                store,
                contract,
                before,
                Date.now() - (performance.now() - start),
                version,
              );
              const current = legacy ? basics : skills;
              const allowed = current
                .map((skill, index) => ({ skill, index }))
                .filter(({ skill }) =>
                  legacy
                    ? skill.preconditions.every(
                        (predicate) => before.facts[predicate] === true,
                      )
                    : applicableProgram(
                        skill,
                        contract,
                        before,
                        adapter.capabilities,
                        bank.lookup,
                      ),
                )
                .map(({ index }) => index);
              const abstain = current.length;
              let choice = legacy ? desired : completeFormProgram(before),
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
                  input[47] = -1;
                }
                prediction = await (
                  method === "initialized"
                    ? initialized
                    : method === "v1_selection"
                      ? v1
                      : method === "v2_public_facts"
                        ? v2
                        : trained
                ).rank(
                  before,
                  [
                    ...allowed.map((index) =>
                      legacy ? basics[index] : candidates[index],
                    ),
                    bank.abstention,
                  ],
                  input,
                  ["v1_selection", "v2_public_facts"].includes(method)
                    ? undefined
                    : screenshotTensor(store.artifactRead(before.image!)),
                );
                choice =
                  prediction.index === allowed.length
                    ? abstain
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
                candidateDescriptorVersion: legacy ? 1 : 2,
                candidateHashes: allowed.map((index) => current[index].hash),
                masksAppliedBeforeRanking: true,
              });
              if (choice === abstain) break;
              const execution = { ...contract, method: current[choice].id };
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
              if (!legacy || choice === 0) {
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
            state = ["ready", "closed", "dialog", "both"][
              Math.floor(episode / 5) % 4
            ],
            missing = scenario === 4,
            desired = missing ? 0 : Math.floor(episode / 5) % 3;
          let proposal = missing ? bank.programs.length : 0;
          await adapter.reset(
            state,
            Math.floor(episode / 20) % 2 ? "shift" : "base",
          );
          const name = "V4 head final " + seed + " " + episode,
            contract = task(name, desired, "v4-head-" + seed + "-" + episode);
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
              4,
            ).context,
            pixels = screenshotTensor(store.artifactRead(before.image!)),
            predictions: Record<string, any> = {},
            ablations: Record<string, any> = {};
          if (!missing) {
            const allowed = skills
              .map((skill, index) => ({ skill, index }))
              .filter(({ skill }) =>
                applicableProgram(
                  skill,
                  contract,
                  before,
                  adapter.capabilities,
                  bank.lookup,
                ),
              )
              .map(({ index }) => index);
            if (!allowed.length)
              throw new Error("Final has no legal proposed program");
            proposal =
              allowed[
                (Math.floor(episode / 20) * 5 + episode) % allowed.length
              ];
          }
          for (const [method, controller] of [
            ["trained", trained],
            ["initialized", initialized],
          ] as const) {
            const prediction = await controller.rank(
              before,
              [candidates[proposal]],
              context,
              pixels,
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
          ablations.normal = predictions.trained;
          for (const condition of ["image_zero", "context_zero", "both_zero"]) {
            const input = ["context_zero", "both_zero"].includes(condition)
              ? new Float32Array(48)
              : context;
            if (input !== context) input[47] = -1;
            const prediction = await trained.rank(
              before,
              [candidates[proposal]],
              input,
              ["image_zero", "both_zero"].includes(condition)
                ? new Float32Array(3072)
                : pixels,
            );
            ablations[condition] = {
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
              !store.run(execution.id).bindings.cleanupFailed &&
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
            proposedProgramHash: missing ? null : skills[proposal].hash,
            candidateDescriptorVersion: 2,
            taskStartForecast: true,
            proposalEligible: true,
            runtimeVerifiedSuccess:
              store.run(executionRunId || contract.id).status === "succeeded",
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
            ablations,
            state,
            policyUsesPublicStateTruth: false,
            stateForwardGoalHidden: true,
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
        await v2.close();
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
    const visualHeadMetrics = protocol.seeds.map((seed: number) =>
      visualMetrics(heads, seed),
    );
    const visualPass = visualHeadMetrics.every(
      (metric: any) =>
        metric.normalAccuracy >= 0.95 &&
        metric.contextZeroAccuracy >= 0.95 &&
        metric.imageBenefit >= 0.2 &&
        metric.imageBenefit95[0] > 0,
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
      status: benefit && headPass && visualPass ? "PASS" : "FAIL",
      id: protocol.id + "-browser",
      track: "browser",
      scope:
        "Controlled browser crossed full-screenshot state and qualified task-start exact-program forecasts",
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
      visualState: visualPass ? "PASS" : "FAIL",
      visualHeadMetrics,
      policyUsesPublicStateTruth: false,
      modelContextUsesPublicStateTruth: false,
      runtimeEligibilityUsesPublicStateTruth: true,
      publicStateTruthScope:
        "Public state facts filter legal programs before selection. Model inputs for state and recovery hide those facts; private head truth remains evaluation targets only.",
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
      candidateDescriptorVersion: 2,
      programBankHash: hash(readFileSync(join(directory, "program-bank.json"))),
      forecastDomain: protocol.forecastDomain,
      comparatorScope:
        "Trained versus initialized use the same typed masked composed/insufficient program bank. V1/V2/no-comp retain their original primitive workflow as reference.",
      skillTemplates: skills.map((skill) =>
        hash(canonical({ ...skill, hash: "", compatibility: [] })),
      ),
      candidateSelectionHash: hash(selectionBytes),
      trainingProvenance,
      sourceQualification: {
        status: safe ? "PASS" : "FAIL",
        trainingProvenance: "PASS",
        currentSourceIdentity:
          "Literal maintained executable source; historical training files are separate read-only evidence",
      },
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
    await finalizeFollowupAudit({
      root,
      directory,
      protocolBytes,
      report,
      cleanup: () => runtime.close(),
      afterCleanup: () => {
        report.sourceAfter = fingerprint();
        report.sourceStable =
          canonical(sourceBefore) === canonical(report.sourceAfter);
        report.protectedAfter = Object.fromEntries(
          protocol.protected.map((path: string) => [
            path,
            hash(readFileSync(path)),
          ]),
        );
      },
    });
    console.log(
      JSON.stringify({
        learningBenefit: report.learningBenefit,
        fullHeads: report.fullHeads,
        paired,
        headMetrics,
        sourceStable: report.sourceStable,
      }),
    );
    if (report.status !== "PASS") process.exitCode = 1;
  } finally {
    if (ownedRuntime) await ownedRuntime.close();
    else {
      try {
        await adapter.close();
      } finally {
        store.close();
      }
    }
  }
}
