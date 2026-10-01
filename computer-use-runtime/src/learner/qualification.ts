import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { canonical, hash } from "../storage/index.js";
import { verifySealedAudit } from "./audit.js";
import { trainingPython } from "./python.js";
import {
  programDescriptor,
  programClosure,
  applicableProgram,
} from "./descriptor.js";
import { checkSkill } from "../skills/index.js";
import {
  followupInputResolution,
  followupTrainingProvenance,
} from "./portable-inputs.js";
import { verifyFollowupTerminal } from "./finalization.js";

export type FollowupQualification = {
  id: string;
  track: "native" | "browser";
  scope: string;
  contextVersion: number;
  visualStateQualified?: boolean;
  candidateDescriptorVersion?: number;
  programBindings?: {
    template: string;
    closure: { id: string; hash: string }[];
  }[];
  protocolHash: string;
  resultsHash: string;
  episodesHash: string;
  models: { seed: number; sha256: string; parameters: number }[];
  skillTemplates: string[];
  learnedCapabilities: (
    "selection" | "predicates" | "recovery" | "clarification" | "outcome_cost"
  )[];
  nativeExecutableSha256?: string;
  issuerKeyPath: string;
  seal: Record<string, unknown>;
};

export function validateAdvisoryHeldoutRows(
  records: unknown[],
  episodesPerSeed: number,
) {
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const numberIn = (value: unknown, minimum: number, maximum: number) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum;
  const integerIn = (value: unknown, minimum: number, maximum: number) =>
    numberIn(value, minimum, maximum) && Number.isInteger(value);
  const probabilityArray = (value: unknown, length: number) =>
    Array.isArray(value) &&
    value.length === length &&
    value.every(
      (item) =>
        typeof item === "number" &&
        Number.isFinite(item) &&
        item >= 0 &&
        item <= 1,
    );
  const finiteArray = (value: unknown, length: number) =>
    Array.isArray(value) &&
    value.length === length &&
    value.every((item) => typeof item === "number" && Number.isFinite(item));
  for (const value of records) {
    const row = object(value);
    if (!row) throw new Error("Full advisory heldout row is malformed");
    const before = object(row.before),
      facts = object(before?.facts),
      predictions = object(row.predictions),
      contract = object(row.contract),
      target = object(contract?.target),
      expected = object(contract?.expected),
      after = object(row.finalObservation),
      finalFacts = object(after?.facts);
    const unresolved = contract?.unresolved;
    const missing = Array.isArray(unresolved) && unresolved.length > 0;
    if (
      typeof row.seed !== "number" ||
      ![17, 41, 73].includes(row.seed) ||
      !integerIn(row.episode, 0, episodesPerSeed - 1) ||
      row.scenario !== Number(row.episode) % 5 ||
      typeof row.observationId !== "string" ||
      !row.observationId ||
      !finiteArray(row.context, 48) ||
      (row.context as number[]).slice(36, 44).some((item) => item !== 0) ||
      !finiteArray(row.proposedDescriptor, 8) ||
      row.generativeCalls !== 0 ||
      row.policyUsesPostActionData !== false ||
      !numberIn(row.elapsedMs, 0, 15000) ||
      !integerIn(row.recoveryTruth, 0, 3) ||
      !Array.isArray(row.predicateTruth) ||
      row.predicateTruth.length !== 3 ||
      row.predicateTruth.some(
        (truth: unknown) =>
          ![-1, 0, 1].includes(Number(truth)) || typeof truth !== "number",
      ) ||
      !integerIn(row.outcomeMask, 0, 1) ||
      !integerIn(row.costMask, 0, 1) ||
      !integerIn(row.outcomeTruth, 0, 1) ||
      !numberIn(row.costTruth, 0, 1) ||
      !before ||
      before.id !== row.observationId ||
      !contract ||
      !target ||
      !Array.isArray(unresolved) ||
      before.host !== target.host ||
      before.session !== target.session ||
      before.target !== target.identity ||
      row.recoveryTruth !==
        (missing
          ? 3
          : facts?.dialog === true
            ? 2
            : facts?.closed === true
              ? 1
              : 0) ||
      (missing
        ? row.runtimeStatus !== "awaiting_input" ||
          row.outcomeMask !== 0 ||
          row.costMask !== 0
        : !after ||
          !expected ||
          !finalFacts ||
          row.outcomeMask !== 1 ||
          after.host !== before.host ||
          after.session !== before.session ||
          after.target !== before.target ||
          !numberIn(after.at, Number(before.at), Number.MAX_SAFE_INTEGER) ||
          row.outcomeTruth !==
            Number(
              Object.entries(expected).every(
                ([key, answer]) => finalFacts[key] === answer,
              ),
            )) ||
      canonical(row.predicateTruth) !==
        canonical(
          ["ready", "closed", "dialog"].map((key) =>
            typeof facts?.[key] === "boolean" ? Number(facts[key]) : -1,
          ),
        ) ||
      ["trained", "initialized"].some((method) => {
        const prediction = object(predictions?.[method]);
        return (
          !prediction ||
          !probabilityArray(prediction.predicates, 3) ||
          !probabilityArray(prediction.outcome, 2) ||
          !integerIn(prediction.recovery, 0, 3) ||
          !numberIn(prediction.latencyMs, 0, 15000)
        );
      })
    )
      throw new Error("Full advisory heldout row violates the frozen protocol");
  }
}

export function recomputeVisualHeadMetrics(
  records: unknown[],
  seeds: number[],
) {
  const rows = records.map((value) => {
    if (!value || typeof value !== "object")
      throw new Error("Visual head row missing");
    const row = value as Record<string, unknown>,
      context = row.context;
    if (
      !Array.isArray(context) ||
      context[45] !== 0 ||
      context[46] !== 0 ||
      context[47] !== -1 ||
      row.policyUsesPublicStateTruth !== false ||
      row.stateForwardGoalHidden !== true ||
      !row.ablations ||
      typeof row.ablations !== "object" ||
      !Array.isArray(row.predicateTruth)
    )
      throw new Error("Visual head inputs expose state or goal-role hints");
    const ablations = row.ablations as Record<string, unknown>;
    const accuracies = Object.fromEntries(
      ["normal", "image_zero", "context_zero", "both_zero"].map((condition) => {
        const value = ablations[condition];
        if (!value || typeof value !== "object")
          throw new Error("Visual ablation condition missing");
        const prediction = value as Record<string, unknown>;
        const probabilities = prediction.predicates;
        if (
          !Array.isArray(probabilities) ||
          probabilities.length !== 3 ||
          probabilities.some(
            (value) =>
              typeof value !== "number" ||
              !Number.isFinite(value) ||
              value < 0 ||
              value > 1,
          )
        )
          throw new Error("Visual ablation predictions are invalid");
        const truth = row.predicateTruth as number[];
        return [
          condition,
          truth.filter(
            (value, index) =>
              value >= 0 && probabilities[index] >= 0.5 === (value === 1),
          ).length / truth.filter((value) => value >= 0).length,
        ];
      }),
    );
    const predictions = row.predictions as Record<string, unknown>;
    if (canonical(ablations.normal) !== canonical(predictions.trained))
      throw new Error(
        "Visual normal condition differs from measured trained prediction",
      );
    return { seed: row.seed, accuracies };
  });
  return seeds.map((seed) => {
    const cases = rows.filter((row) => row.seed === seed);
    const mean = (condition: string) =>
      cases.reduce((sum, row) => sum + row.accuracies[condition], 0) /
      cases.length;
    const differences = cases.map(
      (row) => row.accuracies.normal - row.accuracies.image_zero,
    );
    let random = 90210;
    const samples = [];
    for (let sample = 0; sample < 2000; sample++) {
      let total = 0;
      for (let index = 0; index < cases.length; index++) {
        random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
        total += differences[Math.floor((random / 4294967296) * cases.length)];
      }
      samples.push(total / cases.length);
    }
    samples.sort((a, b) => a - b);
    return {
      seed,
      episodes: cases.length,
      normalAccuracy: mean("normal"),
      imageZeroAccuracy: mean("image_zero"),
      contextZeroAccuracy: mean("context_zero"),
      bothZeroAccuracy: mean("both_zero"),
      imageBenefit:
        differences.reduce((sum, value) => sum + value, 0) / cases.length,
      imageBenefit95: [samples[50], samples[1949]],
    };
  });
}

// This importer is a trusted local evaluator operation. HTTP clients cannot submit
// qualification records, issuer keys or arbitrary final outcomes.
export function verifyFollowupAudit(directory: string): FollowupQualification {
  const path = resolve(directory),
    parent = dirname(path);
  if (
    !/^learning-followup-v\d+$/.test(parent.split(/[\\/]/).pop() || "") ||
    !["native", "browser"].includes(path.split(/[\\/]/).pop() || "")
  )
    throw new Error("Unrecognized followup evidence namespace");
  const protocolBytes = readFileSync(join(parent, "protocol.json")),
    resultBytes = readFileSync(join(path, "results.json")),
    episodesBytes = readFileSync(join(path, "episodes.jsonl"));
  const protocol = JSON.parse(protocolBytes.toString()),
    report = JSON.parse(resultBytes.toString()),
    sealBytes = readFileSync(join(path, "audit-sealed.json")),
    seal = JSON.parse(sealBytes.toString());
  const { signature, ...body } = seal;
  const issuerKeyPath = join(parent, ".evaluator.key"),
    key = readFileSync(issuerKeyPath);
  if (
    key.length !== 32 ||
    typeof signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    throw new Error("Followup has no trusted local evaluator attestation");
  const expected = createHmac("sha256", key).update(canonical(body)).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
    throw new Error("Followup evaluator attestation rejected");
  if (
    hash(protocolBytes) !== seal.protocolHash ||
    hash(resultBytes) !== seal.resultsHash ||
    hash(episodesBytes) !== seal.episodesHash ||
    report.protocolHash !== seal.protocolHash
  )
    throw new Error("Followup audit bytes changed");
  if (
    protocol.id !== parent.split(/[\\/]/).pop() ||
    !report.sourceStable ||
    !seal.sourceStable ||
    canonical(report.sourceBefore) !== canonical(report.sourceAfter)
  )
    throw new Error("Followup did not evaluate stable source");
  const resolutionPath = join(path, "image-resolution.json"),
    resolvedSelectedInputs = new Map<string, string>();
  if (report.sourceAfter[resolutionPath] !== undefined) {
    const bytes = readFileSync(resolutionPath),
      resolution = followupInputResolution(path);
    if (
      protocol.contextVersion !== 4 ||
      report.sourceBefore[resolutionPath] !== hash(bytes) ||
      report.sourceAfter[resolutionPath] !== hash(bytes) ||
      canonical(JSON.parse(bytes.toString())) !== canonical(resolution)
    )
      throw new Error(
        "Local followup input resolution is not bound to its audit",
      );
    for (const input of resolution.selectedInputs) {
      if (
        report.sourceBefore[input.originalPath] !== input.sha256 ||
        report.sourceAfter[input.originalPath] !== input.sha256 ||
        report.sourceBefore[input.localPath] !== input.sha256 ||
        report.sourceAfter[input.localPath] !== input.sha256
      )
        throw new Error(
          "Local selected input alias is not bound to exact bytes",
        );
      resolvedSelectedInputs.set(input.originalPath, input.localPath);
    }
  }
  for (const [source, digest] of Object.entries(report.sourceAfter))
    if (
      typeof digest !== "string" ||
      hash(readFileSync(resolvedSelectedInputs.get(source) || source)) !==
        digest
    )
      throw new Error("Followup evaluated source is stale: " + source);
  if (
    canonical(report.protectedBefore) !== canonical(report.protectedAfter) ||
    protocol.protected.some(
      (source: string) =>
        hash(readFileSync(source)) !== report.protectedBefore[source],
    )
  )
    throw new Error("Protected original audit changed during followup");
  const selectionBytes = readFileSync(join(path, "selection.json")),
    selection = JSON.parse(selectionBytes.toString());
  if (
    hash(selectionBytes) !== report.candidateSelectionHash ||
    selection.status !== "PASS" ||
    selection.protocolHash !== seal.protocolHash
  )
    throw new Error(
      "Followup candidate was not selected under the frozen protocol",
    );
  let testedProgramBank: any;
  if (protocol.contextVersion === 4) {
    const provenance = followupTrainingProvenance(path, report.sourceAfter);
    if (report.trainingProvenance !== undefined) {
      if (
        canonical(report.trainingProvenance) !== canonical(provenance) ||
        report.sourceQualification?.status !== "PASS" ||
        report.sourceQualification?.trainingProvenance !== "PASS" ||
        ("origin" in provenance &&
          provenance.origin.files.some(
            (file) =>
              report.sourceBefore[file.localPath] !== file.sha256 ||
              report.sourceAfter[file.localPath] !== file.sha256,
          ))
      )
        throw new Error(
          "V4 training provenance: signed local origin resolution changed or is incomplete",
        );
    } else if (provenance.kind !== "CURRENT_TRAINING_SOURCE") {
      throw new Error(
        "V4 training provenance: historical origin is not attested by this audit",
      );
    }
  }
  if (protocol.candidateDescriptorVersion === 2) {
    const bankPath = join(path, "program-bank.json"),
      bankBytes = readFileSync(bankPath),
      bank = JSON.parse(bankBytes.toString());
    const lookup = (id: string) =>
      checkSkill(bank.all.find((skill: any) => skill.id === id));
    testedProgramBank = bank;
    const descriptors = bank.programs.map((skill: any) => ({
      descriptor: programDescriptor(checkSkill(skill), lookup),
    }));
    if (
      report.candidateDescriptorVersion !== 2 ||
      selection.candidateDescriptorVersion !== 2 ||
      bank.candidateDescriptorVersion !== 2 ||
      hash(bankBytes) !== report.programBankHash ||
      hash(bankBytes) !== selection.programBankHash ||
      report.sourceAfter[bankPath] !== hash(bankBytes) ||
      canonical(descriptors) !== canonical(bank.descriptors) ||
      new Set(
        descriptors.map((candidate: any) =>
          canonical(Array.from(Float32Array.from(candidate.descriptor))),
        ),
      ).size !== descriptors.length ||
      canonical(
        bank.programs.map((skill: any) =>
          hash(canonical({ ...skill, hash: "", compatibility: [] })),
        ),
      ) !== canonical(report.skillTemplates) ||
      report.models.some(
        (model: any) =>
          model.candidateDescriptorVersion !== 2 ||
          model.programBankHash !== hash(bankBytes),
      )
    )
      throw new Error(
        "V4 tested program identity or normalized descriptor version changed",
      );
  }
  for (const model of report.models) {
    const selected = selection.candidateHashes.find(
      (candidate: { seed: number; sha256: string }) =>
        candidate.seed === model.seed,
    );
    const modelPath = join(path, "models", String(model.seed), "trained.onnx");
    if (
      !selected ||
      selected.sha256 !== model.sha256 ||
      hash(readFileSync(modelPath)) !== model.sha256 ||
      report.sourceBefore[modelPath] !== model.sha256 ||
      report.sourceAfter[modelPath] !== model.sha256
    )
      throw new Error(
        "Audited model bytes differ from the selected checkpoint",
      );
  }
  if (
    canonical(protocol.seeds) !== canonical([17, 41, 73]) ||
    protocol.episodesPerMethodPerSeed < 100 ||
    (report.track === "native" &&
      (!Number.isInteger(protocol.nativeEpisodesPerMethodPerSeed) ||
        protocol.nativeEpisodesPerMethodPerSeed < 12)) ||
    protocol.budgets.steps !== 8 ||
    protocol.budgets.episodeMs !== 15000 ||
    protocol.budgets.generativeCalls !== 0 ||
    protocol.budgets.parameters !== 10000000 ||
    protocol.uncertainty.bootstrapSeed !== 90210 ||
    protocol.uncertainty.bootstrapResamples !== 2000
  )
    throw new Error("Followup protocol weakens protected learning constraints");
  const records = episodesBytes
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const episodes =
    report.track === "native"
      ? protocol.nativeEpisodesPerMethodPerSeed
      : protocol.episodesPerMethodPerSeed;
  if (
    !["native", "browser"].includes(report.track) ||
    records.length !== episodes * protocol.methods.length * 3 ||
    report.episodes !== records.length
  )
    throw new Error("Followup episode count does not match frozen protocol");
  if (
    ![
      "trained",
      "initialized",
      "fixed",
      "without_compilation",
      "frozen_context",
    ].every((method) => protocol.methods.includes(method))
  )
    throw new Error("Required followup baselines missing");
  for (const seed of protocol.seeds)
    for (const method of protocol.methods) {
      const rows = records.filter(
        (row) => row.seed === seed && row.method === method,
      );
      if (
        rows.length !== episodes ||
        new Set(rows.map((row) => row.episode)).size !== episodes ||
        rows.some(
          (row) =>
            !Number.isInteger(row.episode) ||
            row.episode < 0 ||
            row.episode >= episodes,
        )
      )
        throw new Error("Followup paired sessions missing or duplicated");
    }
  if (
    records.some(
      (row) =>
        typeof row.success !== "boolean" ||
        row.falseSuccess !== false ||
        !Number.isFinite(row.observations) ||
        row.observations < 1 ||
        !Number.isFinite(row.elapsedMs) ||
        row.elapsedMs < 0 ||
        row.elapsedMs > 15000 ||
        !Number.isInteger(row.steps) ||
        row.steps < 0 ||
        row.steps > 8 ||
        row.generativeCalls !== 0,
    ) ||
    report.falseSuccess !== 0
  )
    throw new Error("Followup outcomes violate safety or execution budgets");
  const trained = records.filter((row) => row.method === "trained"),
    pairs = trained.map((row) => {
      const initial = records.find(
        (other) =>
          other.method === "initialized" &&
          other.seed === row.seed &&
          other.episode === row.episode,
      );
      return {
        success: Number(row.success) - Number(initial.success),
        observations: row.observations - initial.observations,
      };
    });
  let random = 90210;
  const successes: number[] = [],
    observations: number[] = [];
  for (let sample = 0; sample < 2000; sample++) {
    let success = 0,
      observed = 0;
    for (let index = 0; index < pairs.length; index++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const pair = pairs[Math.floor((random / 4294967296) * pairs.length)];
      success += pair.success;
      observed += pair.observations;
    }
    successes.push(success / pairs.length);
    observations.push(observed / pairs.length);
  }
  successes.sort((a, b) => a - b);
  observations.sort((a, b) => a - b);
  if (
    !(
      successes[50] > 0 ||
      (observations[1949] < 0 && successes[50] >= -0.02)
    ) ||
    report.learningBenefit !== "PASS" ||
    canonical(report.paired) !==
      canonical({
        success95: [successes[50], successes[1949]],
        observations95: [observations[50], observations[1949]],
      })
  )
    throw new Error(
      "Followup learning benefit does not pass recomputed paired gate",
    );
  if (
    report.models.length !== 3 ||
    protocol.seeds.some(
      (seed: number) =>
        !report.models.some(
          (model: {
            seed: number;
            parameters: number;
            reloadMaxError: number;
            onnxMaxError: number;
            validationAccuracy: number;
            parameterUpdateL2: number;
            contextVersion: number;
            policyUsesPostActionData: boolean;
            trainManifestHash: string;
            validationManifestHash: string;
          }) =>
            model.seed === seed &&
            model.parameters > 0 &&
            model.parameters <= 10000000 &&
            model.reloadMaxError === 0 &&
            model.onnxMaxError < 0.0001 &&
            model.validationAccuracy >= 0.95 &&
            model.parameterUpdateL2 > 0 &&
            model.contextVersion === (protocol.contextVersion || 2) &&
            model.policyUsesPostActionData === false &&
            model.trainManifestHash ===
              report.sourceAfter[join(path, "train-manifest.json")] &&
            model.validationManifestHash ===
              report.sourceAfter[join(path, "validation-manifest.json")],
        ),
    )
  )
    throw new Error("Followup training/reload/parity evidence failed");
  const fullCapabilities = [
    "selection",
    "predicates",
    "recovery",
    "clarification",
    "outcome_cost",
  ];
  const learnedCapabilities = [3, 4].includes(protocol.contextVersion)
    ? fullCapabilities
    : ["selection"];
  if ([3, 4].includes(protocol.contextVersion)) {
    const conditionalBytes = readFileSync(
        join(path, "conditional-parity.json"),
      ),
      conditional = JSON.parse(conditionalBytes.toString());
    if (
      hash(conditionalBytes) !==
        report.sourceAfter[join(path, "conditional-parity.json")] ||
      canonical(conditional) !== canonical(report.conditionalParity) ||
      conditional.selectionSha256 !== report.candidateSelectionHash ||
      report.models.some(
        (model: any) =>
          !conditional.models.some(
            (measurement: any) =>
              measurement.seed === model.seed &&
              measurement.sha256 === model.sha256 &&
              measurement.contexts >= 16 &&
              canonical(measurement.candidateCounts) ===
                canonical(
                  protocol.candidateDescriptorVersion === 2
                    ? [1, 2, 3, 4, 8, 9]
                    : [1, 2, 3, 4],
                ) &&
              canonical(measurement.outputs) ===
                canonical(["scores", "predicates", "recovery", "outcome"]) &&
              measurement.maximumError < 0.0001,
          ),
      )
    )
      throw new Error(
        "Conditional advisory export parity is missing or changed",
      );
    if (
      protocol.contextVersion === 4 &&
      conditional.models.some(
        (measurement: any) =>
          canonical(measurement.forwards) !==
          canonical(["selection", "state", "forecast"]),
      )
    )
      throw new Error("Visual export omitted a deployed forward path");
    const headBytes = readFileSync(join(path, "heads.jsonl"));
    if (
      protocol.headEpisodesPerSeed < 100 ||
      hash(headBytes) !== seal.headsHash ||
      hash(headBytes) !== report.headsHash ||
      report.fullHeads !== "PASS" ||
      !protocol.methods.includes("v1_selection")
    )
      throw new Error("Full advisory head evidence is missing or changed");
    const heads = headBytes
      .toString()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    validateAdvisoryHeldoutRows(heads, protocol.headEpisodesPerSeed);
    if (testedProgramBank) {
      const lookup = (id: string) =>
        checkSkill(testedProgramBank.all.find((skill: any) => skill.id === id));
      if (
        heads.some((row: any) => {
          if (
            row.candidateDescriptorVersion !== 2 ||
            row.taskStartForecast !== true ||
            row.proposalEligible !== true ||
            row.runtimeVerifiedSuccess !== (row.runtimeStatus === "succeeded")
          )
            return true;
          if (row.contract.unresolved.length)
            return row.proposedProgramHash !== null;
          const skill = testedProgramBank.programs.find(
            (candidate: any) => candidate.hash === row.proposedProgramHash,
          );
          return (
            !skill ||
            canonical(programDescriptor(skill, lookup)) !==
              canonical(row.proposedDescriptor) ||
            !applicableProgram(
              skill,
              row.contract,
              row.before,
              protocol.capabilities,
              lookup,
            )
          );
        })
      )
        throw new Error(
          "V4 heldout forecast did not use a tested eligible complete program",
        );
    }
    if (protocol.contextVersion === 4) {
      const visualMetrics = recomputeVisualHeadMetrics(heads, protocol.seeds);
      if (
        report.track !== "browser" ||
        report.policyUsesPublicStateTruth !== false ||
        report.visualState !== "PASS" ||
        canonical(protocol.headAblations) !==
          canonical(["normal", "image_zero", "context_zero", "both_zero"]) ||
        canonical(visualMetrics) !== canonical(report.visualHeadMetrics) ||
        visualMetrics.some(
          (metric) =>
            metric.normalAccuracy < 0.95 ||
            metric.contextZeroAccuracy < 0.95 ||
            metric.imageBenefit < 0.2 ||
            metric.imageBenefit95[0] <= 0,
        ) ||
        report.models.some(
          (model: any) => model.policyUsesPublicStateTruth !== false,
        )
      )
        throw new Error(
          "Visual predicate learning fails private-label or image-ablation qualification",
        );
    }
    if (
      heads.length !== 3 * protocol.headEpisodesPerSeed ||
      report.models.some(
        (model: any) =>
          model.trainSessionCount < 600 ||
          model.validationSessionCount < 120 ||
          !["query", "predicate", "recovery", "outcome"].every(
            (head) =>
              Number.isFinite(model.headUpdateL2?.[head]) &&
              model.headUpdateL2[head] > 0,
          ),
      )
    )
      throw new Error(
        "Full advisory training groups or head updates are incomplete",
      );
    for (const seed of protocol.seeds) {
      const rows = heads.filter((row) => row.seed === seed);
      if (
        rows.length !== protocol.headEpisodesPerSeed ||
        new Set(rows.map((row) => row.episode)).size !== rows.length ||
        rows.some(
          (row) =>
            row.generativeCalls !== 0 ||
            row.elapsedMs > 15000 ||
            !Number.isInteger(row.recoveryTruth) ||
            row.recoveryTruth < 0 ||
            row.recoveryTruth > 3 ||
            row.predicateTruth.some(
              (truth: number) => ![-1, 0, 1].includes(truth),
            ) ||
            ["trained", "initialized"].some(
              (method) =>
                row.predictions[method].predicates.some(
                  (value: number) =>
                    !Number.isFinite(value) || value < 0 || value > 1,
                ) ||
                row.predictions[method].outcome.some(
                  (value: number) =>
                    !Number.isFinite(value) || value < 0 || value > 1,
                ),
            ),
        )
      )
        throw new Error(
          "Full advisory heldout rows violate the frozen protocol",
        );
      for (const method of ["trained", "initialized"]) {
        const predictions = rows.map((row) => row.predictions[method]);
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
        const metrics = {
          seed,
          model: method,
          episodes: rows.length,
          predicateAccuracy:
            predicates.filter(
              (row) => row.prediction >= 0.5 === (row.truth === 1),
            ).length / predicates.length,
          recoveryAccuracy:
            rows.filter(
              (row, index) => row.recoveryTruth === predictions[index].recovery,
            ).length / rows.length,
          clarificationRecall:
            clarify.filter((row) => row.prediction === 3).length /
            clarify.length,
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
        if (
          !predicates.length ||
          !clarify.length ||
          !outcomes.length ||
          !costs.length ||
          canonical(metrics) !==
            canonical(
              (method === "trained"
                ? report.headMetrics
                : report.initializedHeadMetrics
              ).find((metric: any) => metric.seed === seed),
            ) ||
          (method === "trained" &&
            (metrics.predicateAccuracy < 0.95 ||
              metrics.recoveryAccuracy < 0.9 ||
              metrics.clarificationRecall < 0.9 ||
              metrics.outcomeBrier > 0.15 ||
              metrics.costMae > 0.15))
        )
          throw new Error(
            "Full advisory heldout metrics fail recomputation or thresholds",
          );
      }
    }
  }
  verifyFollowupTerminal(path, key, protocolBytes, resultBytes, sealBytes);
  verifySealedAudit();
  if (
    report.track === "native" &&
    (!/^[a-f0-9]{64}$/.test(report.nativeExecutableSha256 || "") ||
      report.nativeExecutableSha256 !==
        report.sourceAfter["native/target/release/disposable-editor.exe"] ||
      report.nativeBackend !== "rust-win32-v1" ||
      report.nativePlatform !== "Windows")
  )
    throw new Error("Native tested executable and backend provenance missing");
  if (
    !Array.isArray(report.skillTemplates) ||
    !report.skillTemplates.length ||
    report.skillTemplates.some(
      (template: unknown) =>
        typeof template !== "string" || !/^\w{64}$/.test(template),
    )
  )
    throw new Error("Followup tested skill templates missing");
  const currentSource = spawnSync(
    trainingPython(),
    ["scripts/source-identity.py"],
    { encoding: "utf8", windowsHide: true },
  );
  if (
    currentSource.status !== 0 ||
    JSON.parse(currentSource.stdout).files.some(
      (file: { path: string; sha256: string }) =>
        report.sourceAfter[file.path] !== file.sha256,
    )
  )
    throw new Error(
      "Maintained source inventory differs from the evaluated revision",
    );
  const operationalPath = join(path, "operational.json"),
    operationalBytes = readFileSync(operationalPath),
    operational = JSON.parse(operationalBytes.toString());
  if (
    hash(operationalBytes) !== report.sourceAfter[operationalPath] ||
    canonical(operational) !== canonical(report.operational) ||
    operational.selectionSha256 !== report.candidateSelectionHash ||
    operational.device !== "CPUExecutionProvider" ||
    operational.inferencePasses !==
      (protocol.contextVersion === 4
        ? 3
        : protocol.contextVersion === 3
          ? 2
          : 1) ||
    !(operational.peakProcessRamBytes > 0) ||
    canonical(report.learnedCapabilities) !== canonical(learnedCapabilities) ||
    canonical(operational.learnedCapabilities) !==
      canonical(learnedCapabilities) ||
    report.models.some(
      (model: { seed: number; sha256: string }) =>
        !operational.models.some(
          (measurement: {
            seed: number;
            sha256: string;
            samples: number;
            inferenceMsMedian: number;
            inferenceMsP95: number;
          }) =>
            measurement.seed === model.seed &&
            measurement.sha256 === model.sha256 &&
            measurement.samples >= 100 &&
            Number.isFinite(measurement.inferenceMsMedian) &&
            measurement.inferenceMsMedian > 0 &&
            Number.isFinite(measurement.inferenceMsP95) &&
            measurement.inferenceMsP95 >= measurement.inferenceMsMedian,
        ),
    )
  )
    throw new Error("Followup operational evidence is incomplete or changed");
  return {
    id: report.id,
    track: report.track,
    scope: report.scope,
    contextVersion: protocol.contextVersion || 2,
    ...(protocol.contextVersion === 4 ? { visualStateQualified: true } : {}),
    ...(protocol.candidateDescriptorVersion === 2
      ? {
          candidateDescriptorVersion: 2,
          programBindings: testedProgramBank.programs.map((skill: any) => ({
            template: hash(
              canonical({ ...skill, hash: "", compatibility: [] }),
            ),
            closure: programClosure(skill, (id: string) =>
              checkSkill(
                testedProgramBank.all.find(
                  (candidate: any) => candidate.id === id,
                ),
              ),
            ),
          })),
        }
      : {}),
    protocolHash: seal.protocolHash,
    resultsHash: seal.resultsHash,
    episodesHash: seal.episodesHash,
    models: report.models.map(
      (model: { seed: number; sha256: string; parameters: number }) => ({
        seed: model.seed,
        sha256: model.sha256,
        parameters: model.parameters,
      }),
    ),
    skillTemplates: report.skillTemplates,
    learnedCapabilities:
      learnedCapabilities as FollowupQualification["learnedCapabilities"],
    ...(report.track === "native"
      ? { nativeExecutableSha256: report.nativeExecutableSha256 }
      : {}),
    issuerKeyPath,
    seal,
  };
}
