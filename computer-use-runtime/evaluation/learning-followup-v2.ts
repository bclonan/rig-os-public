import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { Store, hash } from "../src/storage/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { seedForm } from "../src/skills/index.js";
import { repairSkills } from "../src/learner/selector.js";
import { Controller } from "../src/learner/index.js";
import {
  advisoryContext,
  encodeContext,
  productionContext,
} from "../src/learner/context.js";
import { trainingPython } from "../src/learner/python.js";
import type { Observation, TaskContract } from "../src/contracts/index.js";

const command = process.argv[2],
  root = resolve(process.argv[3] || "evidence/learning-followup-v2"),
  directory = join(root, "browser");
const bytes = readFileSync("evaluation/learning-followup-v2.protocol.json"),
  protocol = JSON.parse(bytes.toString());
mkdirSync(directory, { recursive: true });
if (
  existsSync(join(root, "protocol.json")) &&
  hash(readFileSync(join(root, "protocol.json"))) !== hash(bytes)
)
  throw new Error("Frozen v2 protocol changed");
if (!existsSync(join(root, "protocol.json")))
  writeFileSync(join(root, "protocol.json"), bytes, { flag: "wx" });
function fingerprint() {
  const result = spawnSync(trainingPython(), ["scripts/source-identity.py"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("V2 source identity failed");
  const paths = JSON.parse(result.stdout).files.map(
    (file: { path: string; sha256: string }) => [file.path, file.sha256],
  );
  if (command === "audit") {
    for (const name of [
      "selection.json",
      "training.json",
      "train-manifest.json",
      "validation-manifest.json",
      "operational.json",
      "conditional-parity.json",
    ])
      paths.push([
        join(directory, name),
        hash(readFileSync(join(directory, name))),
      ]);
    for (const seed of protocol.seeds)
      for (const name of [
        "initialized.onnx",
        "trained.onnx",
        "initialized.pt",
        "trained.pt",
        "report.json",
      ])
        paths.push([
          join(directory, "models", String(seed), name),
          hash(readFileSync(join(directory, "models", String(seed), name))),
        ]);
    for (const seed of protocol.seeds)
      paths.push([
        resolve(
          "evidence/learning-followup-v1/browser/models/" +
            seed +
            "/trained.onnx",
        ),
        hash(
          readFileSync(
            "evidence/learning-followup-v1/browser/models/" +
              seed +
              "/trained.onnx",
          ),
        ),
      ]);
    for (const split of ["train", "validation"])
      for (const row of JSON.parse(
        readFileSync(join(directory, split + "-manifest.json"), "utf8"),
      ).rows)
        paths.push([row.image, hash(readFileSync(row.image))]);
  }
  return Object.fromEntries(paths);
}
const sourceBefore = fingerprint(),
  protectedBefore = Object.fromEntries(
    protocol.protected.map((path: string) => [path, hash(readFileSync(path))]),
  );
const capabilities = [
  "selection",
  "predicates",
  "recovery",
  "clarification",
  "outcome_cost",
];
const skills = [seedForm(), ...repairSkills()],
  candidates = [...skills, { descriptor: [0, 0, 0, 1, 0, 0, 0, 0] }];
type Row = {
  session: string;
  image: string;
  history: number[][];
  candidates: number[][];
  teacher_choice: number;
  predicate_labels: number[];
  recovery: number;
  success_cost: number[];
  outcome_mask: number[];
  proposedDescriptor: number[];
  [key: string]: unknown;
};
function contractFor(
  adapter: BrowserAdapter,
  name: string,
  role: number,
  expected?: Record<string, string | boolean>,
) {
  const task = structuredTask(
    "Set the display name in the authorized form",
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    { name },
    skills[role].id,
  );
  task.expected =
    expected ||
    (role === 0
      ? { result: name }
      : role === 1
        ? { ready: true }
        : { dialog: false });
  return task;
}
function roleFor(before: Observation) {
  return before.facts.dialog === true
    ? 2
    : before.facts.closed === true
      ? 1
      : 0;
}
function headGate(metrics: any) {
  return (
    metrics.selectionAccuracy >= 0.95 &&
    metrics.predicateAccuracy >= 0.95 &&
    metrics.recoveryAccuracy >= 0.9 &&
    metrics.clarificationRecall >= 0.9 &&
    metrics.outcomeBrier <= 0.15 &&
    metrics.costMae <= 0.15
  );
}
async function collect() {
  if (existsSync(join(directory, "train-manifest.json")))
    throw new Error("V2 development already frozen");
  for (const split of ["train", "validation"]) {
    const originalRoot = resolve("evidence/learning-followup-v1/browser"),
      originalManifest = JSON.parse(
        readFileSync(join(originalRoot, split + "-manifest.json"), "utf8"),
      ),
      originalBundle = JSON.parse(
        readFileSync(join(originalRoot, split + "-bundle.json"), "utf8"),
      );
    const demoBySession = new Map(
      originalBundle.demonstrations.map((demo: any) => [demo.session, demo]),
    );
    const rows: Row[] = originalManifest.rows.map((row: any) => {
      const demo = demoBySession.get(row.session) as any;
      const step = demo.steps.find(
        (step: any) => step.before.image === row.sourceImage,
      );
      const modelContext = advisoryContext(
        demo.contract,
        Float32Array.from(row.history.flat()),
        step.before,
      );
      const proposal = originalBundle.skills.find(
        (skill: any) => skill.id === demo.contract.method,
      ).descriptor;
      return {
        ...row,
        history: Array.from({ length: 4 }, (_, i) =>
          Array.from(modelContext.slice(i * 12, i * 12 + 12)),
        ),
        proposedDescriptor: proposal,
        success_cost: [
          1,
          Math.min(1, (demo.steps.length - demo.steps.indexOf(step)) / 8),
        ],
        outcome_mask: [1, 1],
        sourceManifestHash: hash(
          readFileSync(join(originalRoot, split + "-manifest.json")),
        ),
        contextVersion: 3,
      };
    });
    const store = new Store(join(directory, split + "-store")),
      adapter = await new BrowserAdapter(store, "v2-" + split).start(),
      runtime = new Runtime(store, adapter);
    const initial = await Controller.load(
      join(originalRoot, "models", "17", "initialized.onnx"),
    );
    const imageDirectory = join(directory, split + "-images");
    mkdirSync(imageDirectory, { recursive: true });
    for (const skill of skills) runtime.registry.put(skill);
    async function row(
      task: TaskContract,
      before: Observation,
      group: string,
      proposal: number,
      choice: number,
      outcome: number,
      cost: number,
      mask: number[],
      crop: number[],
    ) {
      const path = join(imageDirectory, before.image + ".png");
      if (!existsSync(path))
        writeFileSync(path, store.artifactRead(before.image!));
      const { context, previous } = productionContext(
        store,
        task,
        before,
        undefined,
        3,
      );
      rows.push({
        session: group,
        image: path,
        crop,
        history: Array.from({ length: 4 }, (_, i) =>
          Array.from(context.slice(i * 12, i * 12 + 12)),
        ),
        candidates: candidates.map((candidate) => candidate.descriptor),
        teacher_choice: choice,
        predicate_labels: ["ready", "closed", "dialog"].map((key) =>
          typeof before.facts[key] === "boolean"
            ? Number(before.facts[key])
            : -1,
        ),
        recovery: task.unresolved.length ? 3 : roleFor(before),
        success_cost: [outcome, cost],
        outcome_mask: mask,
        proposedDescriptor: candidates[proposal].descriptor,
        sourceImage: before.image,
        observationId: before.id,
        taskId: task.id,
        requester: task.requester,
        historyActionIds: previous.map((entry) => entry.action.id),
        policyUsesPostActionData: false,
        contextVersion: 3,
      });
    }
    async function crop() {
      const box = await adapter.page.locator("#indicator").boundingBox();
      if (!box) throw new Error("BEFORE indicator bounds unavailable");
      return [
        Math.floor(box.x + 1),
        Math.floor(box.y + 1),
        Math.floor(box.x + box.width - 1),
        Math.floor(box.y + box.height - 1),
      ];
    }
    async function execute(
      task: TaskContract,
      group: string,
      proposal: number,
      teacher: boolean,
    ) {
      const before = await adapter.observe(),
        bounds = await crop();
      runtime.submit(task, task.id);
      await runtime.execute(task.id);
      const final = await adapter.observe();
      const independentlySucceeded = Object.entries(task.expected).every(
        ([key, value]) => final.facts[key] === value,
      );
      const events = store.events(0, task.id),
        experiences = events
          .filter((event) => event.type === "experience")
          .map((event) => event.data as any);
      const known =
        !["uncertain", "reconciliation_required"].includes(
          store.run(task.id).status,
        ) &&
        events.every(
          (event) =>
            event.type !== "experience" ||
            ["acknowledged", "effect_verified"].includes(
              (event.data as any).receipt?.phase,
            ),
        );
      if (
        teacher &&
        (!independentlySucceeded || store.run(task.id).status !== "succeeded")
      )
        throw new Error(
          "Corrective teacher did not achieve its independently checked output",
        );
      if (experiences.length)
        for (let i = 0; i < experiences.length; i++)
          await row(
            task,
            experiences[i].before,
            group,
            proposal,
            teacher ? proposal : -100,
            Number(independentlySucceeded),
            Math.min(1, (experiences.length - i) / 8),
            [1, Number(known)],
            bounds,
          );
      else
        await row(
          task,
          before,
          group,
          proposal,
          -100,
          Number(independentlySucceeded),
          0,
          [1, 0],
          bounds,
        );
      store.append(
        task.id,
        "learning_independent_label",
        {
          before,
          independentlySucceeded,
          expectedKeys: Object.keys(task.expected),
          source: "Public observed output after actual requested macro",
          corrected: !teacher,
        },
        task.correlationId,
      );
      return { independentlySucceeded, status: store.run(task.id).status };
    }
    try {
      const count = split === "train" ? 100 : 20;
      for (let episode = 0; episode < count; episode++) {
        const group = "v2-" + split + "-reached-" + episode,
          name = "V2 " + split + " reached " + episode;
        await adapter.reset(
          ["ready", "closed", "dialog"][episode % 3],
          episode % 2 ? "shift" : "base",
        );
        const before = await adapter.observe(),
          task = contractFor(adapter, name, 0, { result: name });
        task.requester = group;
        const allowed = skills
          .map((skill, index) => ({ skill, index }))
          .filter(({ skill }) =>
            skill.preconditions.every(
              (predicate) => before.facts[predicate] === true,
            ),
          )
          .map(({ index }) => index);
        const prediction = await initial.rank(
          before,
          [...allowed.map((index) => candidates[index]), candidates[3]],
          encodeContext(task, before, []),
        );
        const proposal =
          prediction.index === allowed.length ? 3 : allowed[prediction.index];
        if (proposal === 3) {
          runtime.submit(task, task.id);
          const bounds = await crop();
          await row(task, before, group, 3, -100, 0, 0, [1, 1], bounds);
          await runtime.control(task.id, "cancel");
          store.append(
            task.id,
            "learning_abstention",
            {
              before,
              prediction,
              independentResult: "Requested public result was not achieved",
            },
            task.correlationId,
          );
        } else
          await execute(
            { ...task, method: skills[proposal].id },
            group,
            proposal,
            false,
          );
        // Reconcile a known disposable fixture by reset after uncertain delivery.
        // Retain the original attempt and its failure, then teach only real effects.
        if (
          store
            .runs()
            .some(
              (run) =>
                run.contract.requester === group &&
                ["uncertain", "reconciliation_required"].includes(run.status),
            )
        )
          await adapter.reset(["ready", "closed", "dialog"][episode % 3]);
        for (let step = 0; step < 3; step++) {
          const current = await adapter.observe(),
            desired = roleFor(current),
            corrective = contractFor(adapter, name, desired);
          corrective.requester = group;
          await execute(corrective, group, desired, true);
          if (desired === 0) break;
        }
        if (episode % 20 === 19)
          console.log(JSON.stringify({ split, reached: episode + 1 }));
      }
      for (let episode = 0; episode < count; episode++) {
        const group = "v2-" + split + "-incomplete-" + episode;
        await adapter.reset(
          ["ready", "closed", "dialog", "both"][episode % 4],
          episode % 2 ? "shift" : "base",
        );
        const task = contractFor(adapter, "", 0);
        task.parameters = {};
        task.unresolved = ["The required display name is missing"];
        task.requester = group;
        runtime.submit(task, task.id);
        if (store.run(task.id).status !== "awaiting_input")
          throw new Error(
            "Incomplete task did not reach actual awaiting-input state",
          );
        const before = await adapter.observe(),
          bounds = await crop();
        await row(task, before, group, 3, -100, 0, 0, [0, 0], bounds);
        store.append(
          task.id,
          "learning_clarification_observation",
          {
            before,
            status: "awaiting_input",
            missing: Object.keys(skills[0].inputs).filter(
              (key) => !(key in task.parameters),
            ),
            authority:
              "Actual required typed field and runtime state; no effect label",
          },
          task.correlationId,
        );
      }
      const groups = new Set(rows.map((row) => row.session));
      if (groups.size !== (split === "train" ? 600 : 120))
        throw new Error("V2 whole-group count mismatch: " + groups.size);
      writeFileSync(
        join(directory, split + "-manifest.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            groups: groups.size,
            rows,
            sourceBefore,
            sourceAfter: fingerprint(),
            protectedBefore,
            originalManifestHash: hash(
              readFileSync(join(originalRoot, split + "-manifest.json")),
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
          positive: rows.filter((row) => row.teacher_choice >= 0).length,
          clarification: rows.filter((row) => row.recovery === 3).length,
        }),
      );
    } finally {
      await initial.close();
      await runtime.close();
    }
  }
}
if (command === "collect") await collect();
else if (command === "train") {
  const result = spawnSync(
    trainingPython(),
    ["learner/followup_v2_train.py", root],
    { encoding: "utf8", windowsHide: true, timeout: 240000 },
  );
  writeFileSync(
    join(directory, "training.log"),
    result.stdout + result.stderr,
    { flag: "wx" },
  );
  if (result.status !== 0)
    throw new Error("V2 training failed: " + result.stderr.slice(-3000));
  const reports = JSON.parse(
      readFileSync(join(directory, "training.json"), "utf8"),
    ),
    selected = reports.every(
      (report: any) =>
        headGate(report.validationHeads) &&
        report.reloadMaxError === 0 &&
        report.onnxMaxError < 0.0001 &&
        Object.values(report.headUpdateL2).every(
          (update) => Number(update) > 0,
        ),
    );
  const decision = {
    status: selected ? "PASS" : "FAIL",
    protocolHash: hash(bytes),
    candidateHashes: reports.map((report: any) => ({
      seed: report.seed,
      sha256: report.sha256,
    })),
    learnedCapabilities: capabilities,
    sourceBefore,
    sourceAfter: fingerprint(),
  };
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
  const { auditFullHeads } = await import("./learning-followup-v2-audit.js");
  await auditFullHeads({
    root,
    directory,
    protocol,
    protocolBytes: bytes,
    sourceBefore,
    protectedBefore,
    fingerprint,
  });
} else throw new Error("Use collect, train or audit");
