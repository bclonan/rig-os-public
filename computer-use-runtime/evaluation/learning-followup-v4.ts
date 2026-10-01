import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  assertFreshFollowupAudit,
  followupInputResolution,
} from "../src/learner/portable-inputs.js";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Store, canonical, hash } from "../src/storage/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { productionContext } from "../src/learner/context.js";
import { applicableProgram } from "../src/learner/descriptor.js";
import { trainingPython } from "../src/learner/python.js";
import {
  browserProgramBank,
  completeFormProgram,
} from "./learning-followup-v4-bank.js";
import type { Observation, TaskContract } from "../src/contracts/index.js";

const command = process.argv[2],
  root = resolve(process.argv[3] || "evidence/learning-followup-v4"),
  directory = join(root, "browser");
if (command === "audit") assertFreshFollowupAudit(directory);
const protocolBytes = readFileSync(
    "evaluation/learning-followup-v4.protocol.json",
  ),
  protocol = JSON.parse(protocolBytes.toString());
mkdirSync(directory, { recursive: true });
if (
  existsSync(join(root, "protocol.json")) &&
  hash(readFileSync(join(root, "protocol.json"))) !== hash(protocolBytes)
)
  throw new Error("Frozen V4 protocol changed");
if (!existsSync(join(root, "protocol.json")))
  writeFileSync(join(root, "protocol.json"), protocolBytes, { flag: "wx" });
const bank = browserProgramBank();
export function headGate(metrics: any) {
  return (
    metrics.selectionAccuracy >= 0.95 &&
    metrics.predicateAccuracy >= 0.95 &&
    metrics.recoveryAccuracy >= 0.9 &&
    metrics.clarificationRecall >= 0.9 &&
    metrics.outcomeBrier <= 0.15 &&
    metrics.costMae <= 0.15
  );
}
function fingerprint() {
  const result = spawnSync(trainingPython(), ["scripts/source-identity.py"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("V4 source identity failed");
  const entries = JSON.parse(result.stdout).files.map((file: any) => [
    file.path,
    file.sha256,
  ]);
  if (command === "audit") {
    for (const name of [
      "selection.json",
      "training.json",
      "train-manifest.json",
      "validation-manifest.json",
      "operational.json",
      "conditional-parity.json",
      "program-bank.json",
    ])
      entries.push([
        join(directory, name),
        hash(readFileSync(join(directory, name))),
      ]);
    for (const seed of protocol.seeds) {
      for (const name of [
        "initialized.onnx",
        "trained.onnx",
        "initialized.pt",
        "trained.pt",
        "report.json",
      ])
        entries.push([
          join(directory, "models", String(seed), name),
          hash(readFileSync(join(directory, "models", String(seed), name))),
        ]);
      for (const version of ["v1", "v2", "v3"]) {
        const path = resolve(
          "evidence/learning-followup-" +
            version +
            "/browser/models/" +
            seed +
            "/trained.onnx",
        );
        entries.push([path, hash(readFileSync(path))]);
      }
    }
    entries.push([
      join(directory, "image-resolution.json"),
      hash(readFileSync(join(directory, "image-resolution.json"))),
    ]);
    if (existsSync(join(directory, "requalification-inputs.json")))
      entries.push([
        join(directory, "requalification-inputs.json"),
        hash(readFileSync(join(directory, "requalification-inputs.json"))),
      ]);
    const resolution = followupInputResolution(directory);
    for (const input of resolution.selectedInputs)
      entries.push([input.originalPath, input.sha256]);
    for (const manifest of resolution.manifests)
      for (const image of manifest.images)
        entries.push([image.localImagePath, image.sha256]);
  }
  return Object.fromEntries(entries);
}
if (command === "audit") {
  const resolutionBytes = JSON.stringify(
      followupInputResolution(directory),
      null,
      2,
    ),
    resolutionPath = join(directory, "image-resolution.json");
  if (existsSync(resolutionPath)) {
    if (readFileSync(resolutionPath, "utf8") !== resolutionBytes)
      throw new Error("Recorded image resolution changed before audit");
  } else writeFileSync(resolutionPath, resolutionBytes, { flag: "wx" });
}
const sourceBefore = fingerprint(),
  protectedBefore = Object.fromEntries(
    protocol.protected.map((path: string) => [path, hash(readFileSync(path))]),
  );
async function collect() {
  if (existsSync(join(directory, "train-manifest.json")))
    throw new Error("V4 development already frozen");
  if (
    new Set(
      bank.descriptors.map((candidate) =>
        canonical(Array.from(Float32Array.from(candidate.descriptor))),
      ),
    ).size !== bank.programs.length
  )
    throw new Error(
      "Tested program features collide at deployed Float32 precision",
    );
  writeFileSync(
    join(directory, "program-bank.json"),
    JSON.stringify(
      {
        candidateDescriptorVersion: 2,
        programs: bank.programs,
        all: bank.all,
        descriptors: bank.descriptors,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  for (const split of ["train", "validation"]) {
    const collectionSourceBefore = fingerprint();
    const store = new Store(join(directory, split + "-store")),
      adapter = await new BrowserAdapter(store, "v4-" + split).start(),
      runtime = new Runtime(store, adapter),
      rows: any[] = [];
    const images = join(directory, split + "-images");
    mkdirSync(images, { recursive: true });
    for (const skill of bank.all) runtime.registry.put(skill);
    function task(name: string, desired: number, group: string) {
      const phrases = protocol.goals[split][desired];
      const contract = structuredTask(
        phrases[group.length % phrases.length],
        {
          host: adapter.host,
          session: adapter.session,
          identity: adapter.identity,
        },
        { name },
        bank.programs[desired].id,
      );
      contract.requester = group;
      contract.expected =
        desired === 0
          ? { result: name }
          : desired === 1
            ? { ready: true }
            : { dialog: false };
      return contract;
    }
    function record(
      contract: TaskContract,
      before: Observation,
      group: string,
      proposal: number,
      choice: number,
      outcome: number,
      cost: number,
      mask: number[],
      evidence: Record<string, unknown>,
    ) {
      const image = join(images, before.image + ".png");
      if (!existsSync(image))
        writeFileSync(image, store.artifactRead(before.image!));
      const { context, previous } = productionContext(
        store,
        contract,
        before,
        undefined,
        4,
      );
      const eligible = bank.programs.map((program) =>
        applicableProgram(
          program,
          contract,
          before,
          adapter.capabilities,
          bank.lookup,
        ),
      );
      rows.push({
        session: group,
        image,
        imageIsFullCapture: true,
        sourceImage: before.image,
        observationId: before.id,
        taskId: contract.id,
        requester: contract.requester,
        history: Array.from({ length: 4 }, (_, index) =>
          Array.from(context.slice(index * 12, index * 12 + 12)),
        ),
        candidates: [...bank.descriptors, bank.abstention].map(
          (candidate) => candidate.descriptor,
        ),
        candidateEligible: [...eligible, true],
        teacher_choice: choice,
        predicate_labels: ["ready", "closed", "dialog"].map((key) =>
          typeof before.facts[key] === "boolean"
            ? Number(before.facts[key])
            : -1,
        ),
        recovery: contract.unresolved.length
          ? 3
          : before.facts.dialog === true
            ? 2
            : before.facts.closed === true
              ? 1
              : 0,
        success_cost: [outcome, cost],
        outcome_mask: mask,
        proposedDescriptor:
          proposal === bank.programs.length
            ? bank.abstention.descriptor
            : bank.descriptors[proposal].descriptor,
        proposedProgramHash:
          proposal === bank.programs.length
            ? null
            : bank.programs[proposal].hash,
        candidateDescriptorVersion: 2,
        contextVersion: 4,
        historyActionIds: previous.map((entry) => entry.action.id),
        policyUsesPostActionData: false,
        forecastDomain:
          "Independent observed task output after exact complete task-start program; Runtime success is separate",
        ...evidence,
      });
    }
    async function execute(
      contract: TaskContract,
      group: string,
      proposal: number,
      teacher: boolean,
    ) {
      const before = await adapter.observe();
      if (
        !applicableProgram(
          bank.programs[proposal],
          contract,
          before,
          adapter.capabilities,
          bank.lookup,
        )
      )
        throw new Error("V4 attempted an ineligible program");
      contract.method = bank.programs[proposal].id;
      runtime.submit(contract, contract.id);
      await runtime.execute(contract.id);
      const after = await adapter.observe(),
        run = store.run(contract.id),
        events = store.events(0, contract.id);
      const success = Object.entries(contract.expected).every(
        ([key, value]) => after.facts[key] === value,
      );
      const experiences = events
        .filter((event) => event.type === "experience")
        .map((event) => event.data as any);
      const requested = events.filter(
        (event) => event.type === "requested",
      ).length;
      const knownCost =
        !run.bindings.cleanupFailed &&
        !["uncertain", "reconciliation_required"].includes(run.status) &&
        experiences.every((experience) =>
          ["acknowledged", "effect_verified"].includes(
            experience.receipt?.phase,
          ),
        );
      if (teacher && (!success || run.status !== "succeeded"))
        throw new Error(
          "V4 teacher failed independent output or Runtime verification",
        );
      const evidence = {
        before,
        finalObservation: after,
        contract,
        executionRunId: contract.id,
        runtimeStatus: run.status,
        runtimeVerifiedSuccess: run.status === "succeeded",
        independentObservedEffect: success,
        receipts: experiences.map((experience) => experience.receipt),
        requestedActions: requested,
        taskStartForecast: true,
      };
      record(
        contract,
        before,
        group,
        proposal,
        teacher ? proposal : -100,
        Number(success),
        requested / 8,
        [1, Number(knownCost)],
        evidence,
      );
      // Later observations are useful for state/selection, but do not assert that restarting the program has the completed run's outcome.
      if (teacher)
        for (const experience of experiences.slice(1))
          record(
            contract,
            experience.before,
            group,
            proposal,
            -100,
            0,
            0,
            [0, 0],
            {
              before: experience.before,
              executionRunId: contract.id,
              taskStartForecast: false,
              runtimeStatus: run.status,
            },
          );
      store.append(
        contract.id,
        "learning_independent_label",
        evidence,
        contract.correlationId,
      );
      return { success, status: run.status };
    }
    try {
      const crossed = split === "train" ? 480 : 96,
        incomplete = split === "train" ? 120 : 24;
      for (let episode = 0; episode < crossed; episode++) {
        const cell = episode % 24,
          desired = cell % 3,
          layout = Math.floor(cell / 3) % 2 ? "shift" : "base",
          state = ["ready", "closed", "dialog", "both"][Math.floor(cell / 6)],
          group = "v4-" + split + "-crossed-" + episode + "-" + randomUUID(),
          name = "V4 " + split + " " + randomUUID();
        await adapter.reset(state, layout);
        const before = await adapter.observe(),
          contract = task(name, desired, group);
        const eligible = bank.programs
          .map((program, index) => ({ program, index }))
          .filter(({ program }) =>
            applicableProgram(
              program,
              contract,
              before,
              adapter.capabilities,
              bank.lookup,
            ),
          )
          .map(({ index }) => index);
        if (!eligible.length)
          throw new Error("Crossed development has no legal program");
        const offset = Math.floor(episode / 24) * 5 + cell;
        const proposals = [
          eligible[offset % eligible.length],
          ...(desired === 0
            ? [
                eligible[
                  (offset + Math.ceil(eligible.length / 2)) % eligible.length
                ],
              ]
            : []),
        ];
        for (let attempt = 0; attempt < proposals.length; attempt++) {
          if (attempt) await adapter.reset(state, layout);
          const result = await execute(
            task(name, desired, group),
            group,
            proposals[attempt],
            false,
          );
          if (["uncertain", "reconciliation_required"].includes(result.status))
            await adapter.reset(state, layout);
        }
        const current = await adapter.observe();
        await execute(
          task(name, 0, group),
          group,
          completeFormProgram(current),
          true,
        );
        if (episode % 24 === 23)
          console.log(
            JSON.stringify({ split, crossed: episode + 1, rows: rows.length }),
          );
      }
      for (let episode = 0; episode < incomplete; episode++) {
        const group =
          "v4-" + split + "-incomplete-" + episode + "-" + randomUUID();
        await adapter.reset(
          ["ready", "closed", "dialog", "both"][episode % 4],
          Math.floor(episode / 4) % 2 ? "shift" : "base",
        );
        const contract = task("", 0, group);
        contract.parameters = {};
        contract.unresolved = ["The required display name is missing"];
        runtime.submit(contract, contract.id);
        const before = await adapter.observe();
        if (store.run(contract.id).status !== "awaiting_input")
          throw new Error("Missing contract did not reach awaiting_input");
        record(
          contract,
          before,
          group,
          bank.programs.length,
          bank.programs.length,
          0,
          0,
          [0, 0],
          {
            before,
            contract,
            runtimeStatus: "awaiting_input",
            taskStartForecast: true,
          },
        );
        store.append(
          contract.id,
          "learning_abstention",
          { before, reason: "Actual incomplete typed contract" },
          contract.correlationId,
        );
      }
      const groups = new Set(rows.map((row) => row.session));
      if (groups.size !== (split === "train" ? 600 : 120))
        throw new Error("V4 whole-group split count mismatch");
      writeFileSync(
        join(directory, split + "-manifest.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            groups: groups.size,
            rows,
            protocolHash: hash(protocolBytes),
            candidateDescriptorVersion: 2,
            programBankHash: hash(
              readFileSync(join(directory, "program-bank.json")),
            ),
            collectionSourceBefore,
            collectionSourceAfter: fingerprint(),
            protectedBefore,
            protectedAfter: Object.fromEntries(
              protocol.protected.map((path: string) => [
                path,
                hash(readFileSync(path)),
              ]),
            ),
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
      console.log(
        JSON.stringify({
          split,
          groups: groups.size,
          rows: rows.length,
          knownPositive: rows.filter(
            (row) => row.outcome_mask[0] && row.success_cost[0],
          ).length,
          knownNegative: rows.filter(
            (row) => row.outcome_mask[0] && !row.success_cost[0],
          ).length,
          unknownCost: rows.filter(
            (row) => row.outcome_mask[0] && !row.outcome_mask[1],
          ).length,
        }),
      );
    } finally {
      await runtime.close();
    }
  }
}
if (command === "collect") await collect();
else if (command === "train") {
  const trainingSource = () =>
    Object.fromEntries(
      [
        "learner/model.py",
        "learner/model_v4.py",
        "learner/followup_v4_train.py",
        "learner/recorded.py",
        "src/learner/descriptor.ts",
        "evaluation/learning-followup-v4.protocol.json",
        join(directory, "program-bank.json"),
        join(directory, "train-manifest.json"),
        join(directory, "validation-manifest.json"),
      ].map((path) => [path, hash(readFileSync(path))]),
    );
  const trainingSourceBefore = trainingSource();
  const result = spawnSync(
    trainingPython(),
    ["learner/followup_v4_train.py", root],
    { encoding: "utf8", windowsHide: true, timeout: 480000 },
  );
  writeFileSync(
    join(directory, "training.log"),
    result.stdout + result.stderr,
    { flag: "wx" },
  );
  if (result.status !== 0)
    throw new Error("V4 training failed: " + result.stderr.slice(-3000));
  const reports = JSON.parse(
    readFileSync(join(directory, "training.json"), "utf8"),
  );
  const selected = reports.every(
    (report: any) =>
      headGate(report.validationHeads) &&
      report.reloadMaxError === 0 &&
      report.onnxMaxError < 0.0001 &&
      Object.values(report.headUpdateL2).every((update) => Number(update) > 0),
  );
  const decision = {
    status: selected ? "PASS" : "FAIL",
    protocolHash: hash(protocolBytes),
    candidateHashes: reports.map((report: any) => ({
      seed: report.seed,
      sha256: report.sha256,
    })),
    candidateDescriptorVersion: 2,
    programBankHash: hash(readFileSync(join(directory, "program-bank.json"))),
    learnedCapabilities: [
      "selection",
      "predicates",
      "recovery",
      "clarification",
      "outcome_cost",
    ],
    sourceBefore,
    sourceAfter: fingerprint(),
    trainingSourceBefore,
    trainingSourceAfter: trainingSource(),
  };
  if (
    canonical(trainingSourceBefore) !== canonical(decision.trainingSourceAfter)
  )
    throw new Error("V4 training source changed during optimization");
  writeFileSync(
    join(directory, "selection.json"),
    JSON.stringify(decision, null, 2),
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      status: decision.status,
      metrics: reports.map((report: any) => ({
        seed: report.seed,
        validation: report.validationHeads,
        updates: report.headUpdateL2,
      })),
    }),
  );
  if (!selected) process.exitCode = 1;
} else if (command === "audit") {
  const { auditFullHeads } = await import("./learning-followup-v4-audit.js");
  await auditFullHeads({
    root,
    directory,
    protocol,
    protocolBytes,
    sourceBefore,
    protectedBefore,
    fingerprint,
  });
} else throw new Error("Use collect, train or audit");
