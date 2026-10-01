import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store, canonical, hash } from "../src/storage/index.js";
import { createHmac, randomBytes } from "node:crypto";
import { Runtime } from "../src/runtime/index.js";
import { NativeClient, WindowsAdapter } from "../src/adapters/native.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { structuredTask } from "../src/compiler/intent.js";
import { seedForm, seal } from "../src/skills/index.js";
import { Recorder } from "../src/recorder/index.js";
import { exportDataset } from "../src/recorder/bundle.js";
import { Controller } from "../src/learner/index.js";
import { productionContext } from "../src/learner/context.js";
import { screenshotTensor } from "../src/learner/image.js";
import { trainingPython } from "../src/learner/python.js";
import { repairSkills } from "../src/learner/selector.js";
import type { SkillCapsule, TaskContract } from "../src/contracts/index.js";

const command = process.argv[2],
  track = process.argv[3] || "native",
  root = resolve(process.argv[4] || "evidence/learning-followup-v1");
const protocolBytes = readFileSync(
  "evaluation/learning-followup.protocol.json",
);
const protocol = JSON.parse(protocolBytes.toString());
if (!["native", "browser"].includes(track))
  throw new Error("Unknown followup track");
mkdirSync(root, { recursive: true });
const protocolPath = join(root, "protocol.json");
if (
  existsSync(protocolPath) &&
  hash(readFileSync(protocolPath)) !== hash(protocolBytes)
)
  throw new Error("Frozen followup protocol changed");
if (!existsSync(protocolPath))
  writeFileSync(protocolPath, protocolBytes, { flag: "wx" });
const protectedPaths: string[] = protocol.protected;
const protectedBefore = Object.fromEntries(
  protectedPaths.map((path) => [path, hash(readFileSync(path))]),
);
const sourcePaths = [
  "evaluation/learning-followup.ts",
  "evaluation/learning-followup.protocol.json",
  ...readdirSync("src/learner")
    .filter((path) => path.endsWith(".ts"))
    .map((path) => "src/learner/" + path),
  ...readdirSync("learner")
    .filter((path) => path.endsWith(".py"))
    .map((path) => "learner/" + path),
  "src/runtime/index.ts",
  "src/runtime/program.ts",
  "src/runtime/policy.ts",
  "src/contracts/index.ts",
  "src/predicates/index.ts",
  "src/storage/index.ts",
  "src/skills/index.ts",
  "src/adapters/native.ts",
  "src/adapters/browser.ts",
  "src/compiler/intent.ts",
  "src/recorder/index.ts",
  "src/recorder/bundle.ts",
  "package.json",
  "package-lock.json",
  "native/src/windows.rs",
  "native/src/accessibility.rs",
  "native/src/fixture.rs",
  "native/Cargo.toml",
  "native/Cargo.lock",
];
if (command === "audit") {
  sourcePaths.push(
    join(root, track, "selection.json"),
    join(root, track, "training.json"),
    join(root, track, "operational.json"),
    join(root, "protocol.json"),
  );
  for (const seed of protocol.seeds)
    for (const name of [
      "trained.onnx",
      "initialized.onnx",
      "trained.pt",
      "initialized.pt",
      "report.json",
    ])
      sourcePaths.push(join(root, track, "models", String(seed), name));
  for (const split of ["train", "validation"]) {
    const manifestPath = join(root, track, split + "-manifest.json");
    sourcePaths.push(
      manifestPath,
      join(root, track, split + "-bundle.json"),
      join(root, track, split + "-collection.json"),
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    sourcePaths.push(
      ...(new Set(
        manifest.rows.map((row: { image: string }) => row.image),
      ) as Set<string>),
    );
  }
}
if (track === "native")
  sourcePaths.push(
    "native/target/release/disposable-editor.exe",
    "native/target/release/computer-use-native.exe",
  );
const fingerprint = () => {
  const result = spawnSync(trainingPython(), ["scripts/source-identity.py"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("Maintained source identity failed");
  const identity = JSON.parse(result.stdout);
  return {
    ...Object.fromEntries(
      identity.files.map((file: { path: string; sha256: string }) => [
        file.path,
        file.sha256,
      ]),
    ),
    ...Object.fromEntries(
      sourcePaths.map((path) => [path, hash(readFileSync(path))]),
    ),
  };
};
const sourceBefore = fingerprint();
const directory = join(root, track);
mkdirSync(directory, { recursive: true });
const sourceHead = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
  windowsHide: true,
}).stdout.trim();

function nativeSkills(identity: string): SkillCapsule[] {
  const base = {
    ...seedForm(),
    compatibility: [identity],
    outputs: ["text"],
    preconditions: ["focused"],
  };
  return [
    seal({
      ...base,
      id: "native.replace",
      description: "Replace authorized editable text",
      capabilities: ["fill"],
      descriptor: [1, 0, 0, 0, 0, 0, 0, 0],
      machine: {
        initial: "replace",
        states: [
          {
            id: "replace",
            steps: [
              {
                id: "replace",
                operation: "fill",
                args: { locator: "101", value: "$name" },
                scope: "edit",
              },
            ],
            monitor: ["focused"],
          },
        ],
      },
    }),
    seal({
      ...base,
      id: "native.append",
      description: "Append authorized editable text",
      capabilities: ["click", "key", "type"],
      descriptor: [0, 1, 0, 0, 0, 0, 0, 0],
      machine: {
        initial: "append",
        states: [
          {
            id: "append",
            steps: [
              {
                id: "click",
                operation: "click",
                args: { locator: "101" },
                scope: "edit",
              },
              {
                id: "end",
                operation: "key",
                args: { key: "Control+End" },
                scope: "edit",
              },
              {
                id: "append",
                operation: "type",
                args: { text: "$name" },
                scope: "edit",
              },
            ],
            monitor: ["focused"],
          },
        ],
      },
    }),
  ];
}
function taskFor(
  adapter: { host: string; session: string; identity: string },
  name: string,
  skill: SkillCapsule,
  expected: Record<string, string | boolean>,
  role = 0,
): TaskContract {
  const task = structuredTask(
    track === "native"
      ? role
        ? "Append text to the authorized editor"
        : "Replace the authorized editor text"
      : "Set the display name in the authorized form",
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    { name },
    skill.id,
  );
  task.expected = expected;
  task.budgets.steps = 8;
  task.budgets.deadlineMs = 15000;
  task.requester = "learning-followup-" + task.id;
  return task;
}
async function nativeEnvironment(store: Store) {
  if (process.platform !== "win32")
    throw new Error(
      "Native followup requires the real Windows interactive session",
    );
  const fixture = spawn(
    resolve("native/target/release/disposable-editor.exe"),
    [],
    { windowsHide: false, stdio: "ignore" },
  );
  const probe = new NativeClient();
  try {
    let window: { handle: number; pid: number; title: string } | undefined;
    for (let attempt = 0; attempt < 20 && !window; attempt++) {
      await delay(100);
      const windows = await probe.call("windows");
      window = windows.find(
        (candidate: { pid: number; title: string }) =>
          candidate.pid === fixture.pid &&
          candidate.title === "Computer use disposable editor",
      );
    }
    if (!window) throw new Error("Owned disposable editor did not appear");
    const adapter = await new WindowsAdapter(store, false).start(window.handle);
    await adapter.client.call("focus", { handle: window.handle });
    return { adapter, fixture, handle: window.handle };
  } catch (error) {
    fixture.kill();
    throw error;
  } finally {
    await probe.close();
  }
}
function convertBundle(store: Store, skills: SkillCapsule[], name: string) {
  const bundlePath = join(directory, name + "-bundle.json");
  const bundle = {
    ...exportDataset(store, { unredacted: true }),
    skills: [
      ...skills,
      { id: "abstain", descriptor: [0, 0, 0, 1, 0, 0, 0, 0] },
    ],
  };
  writeFileSync(bundlePath, JSON.stringify(bundle));
  const output = join(directory, name + "-converted");
  const result = spawnSync(
    trainingPython(),
    [
      "-c",
      "import sys;sys.path.insert(0,'learner');from recorded import load_bundle;load_bundle(sys.argv[1],sys.argv[2])",
      bundlePath,
      output,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 60000 },
  );
  if (result.status !== 0)
    throw new Error(
      "Recorded conversion failed: " + result.stderr.slice(-3000),
    );
  const manifest = JSON.parse(
    readFileSync(join(output, "recorded-manifest.json"), "utf8"),
  );
  writeFileSync(
    join(directory, name + "-manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}
function intervals(
  records: Array<{
    seed: number;
    method: string;
    episode: number;
    success: boolean;
    falseSuccess: boolean;
    observations: number;
    elapsedMs: number;
  }>,
) {
  const grouped = protocol.seeds.flatMap((seed: number) =>
    protocol.methods.map((method: string) => {
      const rows = records.filter(
          (row) => row.seed === seed && row.method === method,
        ),
        n = rows.length,
        successes = rows.filter((row) => row.success).length,
        p = successes / n,
        z = 1.96,
        denominator = 1 + (z * z) / n,
        midpoint = (p + (z * z) / (2 * n)) / denominator,
        half =
          (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denominator;
      return {
        seed,
        method,
        episodes: n,
        successes,
        successRate: p,
        success95: [midpoint - half, midpoint + half],
        falseSuccess: rows.filter((row) => row.falseSuccess).length,
        meanObservations:
          rows.reduce((sum, row) => sum + row.observations, 0) / n,
        meanElapsedMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0) / n,
      };
    }),
  );
  const paired = records
    .filter((row) => row.method === "trained")
    .map((row) => {
      const baseline = records.find(
        (candidate) =>
          candidate.seed === row.seed &&
          candidate.episode === row.episode &&
          candidate.method === "initialized",
      )!;
      return {
        success: Number(row.success) - Number(baseline.success),
        observations: row.observations - baseline.observations,
      };
    });
  let random = protocol.uncertainty.bootstrapSeed;
  const samples = { success: [] as number[], observations: [] as number[] };
  for (let sample = 0; sample < 2000; sample++) {
    let success = 0,
      observations = 0;
    for (let index = 0; index < paired.length; index++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const pair = paired[Math.floor((random / 4294967296) * paired.length)];
      success += pair.success;
      observations += pair.observations;
    }
    samples.success.push(success / paired.length);
    samples.observations.push(observations / paired.length);
  }
  samples.success.sort((a, b) => a - b);
  samples.observations.sort((a, b) => a - b);
  const success95 = [samples.success[50], samples.success[1949]],
    observations95 = [samples.observations[50], samples.observations[1949]];
  return {
    grouped,
    paired: { success95, observations95 },
    learningBenefit:
      !records.some((row) => row.falseSuccess) &&
      (success95[0] > 0 || (observations95[1] < 0 && success95[0] >= -0.02))
        ? "PASS"
        : "FAIL",
  };
}

try {
  if (command === "collect") {
    if (existsSync(join(directory, "train-manifest.json")))
      throw new Error(
        "Development dataset already frozen; use a new campaign version instead of overwriting it",
      );
    for (const split of ["train", "validation"]) {
      const store = new Store(join(directory, split + "-store"));
      let fixture: ReturnType<typeof spawn> | undefined;
      let adapter: WindowsAdapter | BrowserAdapter;
      let handle = 0;
      if (track === "native") {
        const environment = await nativeEnvironment(store);
        adapter = environment.adapter;
        fixture = environment.fixture;
        handle = environment.handle;
      } else
        adapter = await new BrowserAdapter(store, "followup-" + split).start();
      const runtime = new Runtime(store, adapter);
      try {
        const skills =
          track === "native"
            ? nativeSkills(adapter.identity)
            : [seedForm(), ...repairSkills()];
        for (const skill of skills) runtime.registry.put(skill);
        const recorder = new Recorder(store),
          count =
            protocol[
              split === "train" ? "trainingSessions" : "validationSessions"
            ][track];
        for (let session = 0; session < count; session++) {
          const name =
            "Followup-" +
            split +
            "-" +
            session +
            "-" +
            hash(split + "-" + session).slice(0, 12);
          if (track === "native") {
            const prefix =
              "Existing " + hash(split + "prefix" + session).slice(0, 10) + " ";
            const reset = taskFor(adapter, prefix, skills[0], { text: prefix });
            runtime.submit(reset, reset.id);
            await runtime.execute(reset.id);
            if (store.run(reset.id).status !== "succeeded")
              throw new Error("Native reset failed");
            const role = session % 2,
              expected = role ? prefix + name : name;
            const task = taskFor(
              adapter,
              name,
              skills[role],
              { text: expected },
              role,
            );
            runtime.submit(task, task.id);
            await runtime.execute(task.id);
            const actual = (
              await (adapter as WindowsAdapter).client.call("fixture_text", {
                handle,
              })
            ).text;
            if (
              store.run(task.id).status !== "succeeded" ||
              actual !== expected
            )
              throw new Error("Independent native development label rejected");
            recorder.capture(task.id);
          } else {
            const browser = adapter as BrowserAdapter,
              mode = ["ready", "closed", "dialog"][session % 3];
            await browser.reset(mode, session % 2 ? "shift" : "base");
            const role = session % 3;
            const expected: Record<string, string | boolean> =
              role === 0
                ? { result: name }
                : role === 1
                  ? { ready: true }
                  : { dialog: false };
            const task = taskFor(adapter, name, skills[role], expected);
            runtime.submit(task, task.id);
            await runtime.execute(task.id);
            if (store.run(task.id).status !== "succeeded")
              throw new Error("Independent browser development label rejected");
            recorder.capture(task.id);
          }
          if (session % 20 === 19)
            console.log(
              JSON.stringify({ track, split, completed: session + 1 }),
            );
        }
        const manifest = convertBundle(store, skills, split);
        writeFileSync(
          join(directory, split + "-collection.json"),
          JSON.stringify(
            {
              status: "PASS",
              sessions: count,
              counts: manifest.counts,
              sourceHead,
              protectedBefore,
              sourceBefore,
              sourceAfter: fingerprint(),
            },
            null,
            2,
          ),
        );
      } finally {
        await runtime.close();
        fixture?.kill();
      }
    }
  } else if (command === "rebuild-private-development") {
    if (
      existsSync(join(directory, "selection.json")) ||
      existsSync(join(directory, "audit-sealed.json"))
    )
      throw new Error(
        "Candidate selection/final evidence prevents dataset rebuild",
      );
    const stamp = Date.now();
    for (const name of ["models", "training.log"]) {
      const original = join(directory, name),
        retained = join(directory, name + "-failed-" + stamp);
      if (existsSync(original)) {
        if (
          !resolve(original).startsWith(root + "\\") &&
          !resolve(original).startsWith(root + "/")
        )
          throw new Error("Development repair path escapes campaign");
        renameSync(original, retained);
      }
    }
    for (const split of ["train", "validation"]) {
      for (const suffix of [
        "bundle.json",
        "manifest.json",
        "collection.json",
      ]) {
        const original = join(directory, split + "-" + suffix);
        if (existsSync(original))
          renameSync(
            original,
            join(
              directory,
              split + "-redacted-failure-" + stamp + "-" + suffix,
            ),
          );
      }
      const store = new Store(join(directory, split + "-store"));
      try {
        const skills = store
          .list<SkillCapsule>("skills")
          .filter((skill) =>
            track === "native"
              ? skill.id.startsWith("native.")
              : skill.id === "form.seed" || skill.id.startsWith("repair."),
          );
        const manifest = convertBundle(
          store,
          skills.sort((a, b) =>
            track === "native"
              ? Number(a.id === "native.append") -
                Number(b.id === "native.append")
              : 0,
          ),
          split,
        );
        writeFileSync(
          join(directory, split + "-collection.json"),
          JSON.stringify(
            {
              status: "PASS",
              repair:
                "Explicit authorized private export from original independently checked disposable fixture store",
              counts: manifest.counts,
              sourceHead,
              sourceBefore,
              sourceAfter: fingerprint(),
            },
            null,
            2,
          ),
        );
      } finally {
        store.close();
      }
    }
  } else if (command === "train") {
    const result = spawnSync(
      trainingPython(),
      ["learner/followup_train.py", root, track],
      { encoding: "utf8", windowsHide: true, timeout: 180000 },
    );
    writeFileSync(
      join(directory, "training.log"),
      result.stdout + result.stderr,
    );
    if (result.status !== 0)
      throw new Error(
        "CPU followup training failed: " + result.stderr.slice(-3000),
      );
    const reports = JSON.parse(
      readFileSync(join(directory, "training.json"), "utf8"),
    );
    const selected = reports.every(
      (report: {
        validationAccuracy: number;
        reloadMaxError: number;
        onnxMaxError: number;
        parameterUpdateL2: number;
      }) =>
        report.validationAccuracy >= 0.95 &&
        report.reloadMaxError === 0 &&
        report.onnxMaxError < 0.0001 &&
        report.parameterUpdateL2 > 0,
    );
    const decision = {
      status: selected ? "PASS" : "FAIL",
      protocolHash: hash(protocolBytes),
      candidateHashes: reports.map(
        (report: { seed: number; sha256: string }) => ({
          seed: report.seed,
          sha256: report.sha256,
        }),
      ),
      rule: protocol.selection,
      sourceBefore,
      sourceAfter: fingerprint(),
    };
    writeFileSync(
      join(directory, "selection.json"),
      JSON.stringify(decision, null, 2),
      { flag: "wx" },
    );
    console.log(JSON.stringify(decision));
    if (!selected) process.exitCode = 1;
  } else if (command === "audit") {
    const selection = JSON.parse(
      readFileSync(join(directory, "selection.json"), "utf8"),
    );
    if (selection.status !== "PASS")
      throw new Error("No validation-selected candidate");
    const trainedReports = JSON.parse(
      readFileSync(join(directory, "training.json"), "utf8"),
    );
    for (const seed of protocol.seeds) {
      const selected = selection.candidateHashes.find(
          (candidate: { seed: number }) => candidate.seed === seed,
        ),
        report = trainedReports.find(
          (candidate: { seed: number }) => candidate.seed === seed,
        );
      if (
        !selected ||
        !report ||
        selected.sha256 !== report.sha256 ||
        report.trainManifestHash !==
          hash(readFileSync(join(directory, "train-manifest.json"))) ||
        report.validationManifestHash !==
          hash(readFileSync(join(directory, "validation-manifest.json"))) ||
        hash(
          readFileSync(join(directory, "models", String(seed), "trained.onnx")),
        ) !== selected.sha256
      )
        throw new Error("Selected checkpoint changed before final evaluation");
    }
    if (existsSync(join(directory, "audit-sealed.json")))
      throw new Error(
        "Followup final outcomes are sealed; do not use them as a tuning loop",
      );
    const store = new Store(join(directory, "audit-store"));
    let fixture: ReturnType<typeof spawn> | undefined;
    let handle = 0;
    let adapter: WindowsAdapter | BrowserAdapter;
    if (track === "native") {
      const environment = await nativeEnvironment(store);
      adapter = environment.adapter;
      fixture = environment.fixture;
      handle = environment.handle;
    } else adapter = await new BrowserAdapter(store, "followup-final").start();
    const runtime = new Runtime(store, adapter);
    let capturedObservations = 0;
    const capture = adapter.observe.bind(adapter);
    adapter.observe = (signal?: AbortSignal) => {
      capturedObservations++;
      return capture(signal);
    };
    const records: Array<
      {
        seed: number;
        method: string;
        episode: number;
        success: boolean;
        falseSuccess: boolean;
        observations: number;
        elapsedMs: number;
      } & Record<string, unknown>
    > = [];
    try {
      const skills =
        track === "native"
          ? nativeSkills(adapter.identity)
          : [seedForm(), ...repairSkills()];
      for (const skill of skills) runtime.registry.put(skill);
      const candidates = [...skills, { descriptor: [0, 0, 0, 1, 0, 0, 0, 0] }],
        episodes =
          track === "native"
            ? protocol.nativeEpisodesPerMethodPerSeed
            : protocol.episodesPerMethodPerSeed;
      for (const seed of protocol.seeds) {
        const trained = await Controller.load(
            join(directory, "models", String(seed), "trained.onnx"),
          ),
          initialized = await Controller.load(
            join(directory, "models", String(seed), "initialized.onnx"),
          );
        try {
          for (const method of protocol.methods)
            for (let episode = 0; episode < episodes; episode++) {
              const name =
                  "Final-" +
                  seed +
                  "-" +
                  episode +
                  "-" +
                  hash(
                    "final-" + seed + "-" + episode + "-" + hash(protocolBytes),
                  ).slice(0, 12),
                prefix =
                  "Existing final " +
                  hash(seed + ":" + episode).slice(0, 12) +
                  " ",
                role = episode % 2;
              if (track === "native") {
                const reset = taskFor(adapter, prefix, skills[0], {
                  text: prefix,
                });
                runtime.submit(reset, reset.id);
                await runtime.execute(reset.id);
                if (store.run(reset.id).status !== "succeeded")
                  throw new Error("Final native reset failed");
              } else
                await (adapter as BrowserAdapter).reset(
                  ["ready", "closed", "dialog", "both"][episode % 4],
                  episode % 3 === 0 ? "shift" : "base",
                );
              const start = performance.now();
              const observationsBefore = capturedObservations;
              let steps = 0,
                claimed = false,
                abstentions = 0;
              const runs: string[] = [];
              const choices: number[] = [];
              const inferenceTimes: number[] = [];
              const decisionContexts: {
                observationId: string;
                historyActionIds: string[];
                context: number[];
              }[] = [];
              while (steps < 8 && performance.now() - start < 15000) {
                const before = await adapter.observe();
                if (
                  track === "native" &&
                  (before.backend !== "rust-win32-v1" ||
                    before.facts.desktopPlatform !== "Windows" ||
                    before.facts.windowPid !== fixture!.pid ||
                    before.facts.windowExecutableSha256 !==
                      sourceBefore[
                        "native/target/release/disposable-editor.exe"
                      ])
                )
                  throw new Error(
                    "Final native observation is outside the owned tested executable",
                  );
                const desired =
                  track === "native"
                    ? role
                    : before.facts.dialog === true
                      ? 2
                      : before.facts.closed === true
                        ? 1
                        : 0;
                const contract = taskFor(
                  adapter,
                  name,
                  skills[desired],
                  track === "native"
                    ? { text: role ? prefix + name : name }
                    : desired === 0
                      ? { result: name }
                      : desired === 1
                        ? { ready: true }
                        : { dialog: false },
                  role,
                );
                contract.requester =
                  "learning-followup-final-" +
                  seed +
                  "-" +
                  episode +
                  "-" +
                  method;
                const { context: history, previous } = productionContext(
                  store,
                  contract,
                  before,
                  Date.now() - (performance.now() - start),
                );
                decisionContexts.push({
                  observationId: before.id,
                  historyActionIds: previous.map((entry) => entry.action.id),
                  context: Array.from(history),
                });
                let choice: number,
                  inferenceMs = 0;
                const allowedIndices = skills
                  .map((skill, index) => ({ skill, index }))
                  .filter(
                    ({ skill }) =>
                      skill.preconditions.every(
                        (predicate) => before.facts[predicate] === true,
                      ) &&
                      skill.effects.every((effect) =>
                        contract.effects.includes(effect),
                      ) &&
                      skill.capabilities.every((capability) =>
                        adapter.capabilities.includes(capability),
                      ),
                  )
                  .map(({ index }) => index);
                const available = [
                  ...allowedIndices.map((index) => candidates[index]),
                  candidates[skills.length],
                ];
                if (method === "fixed")
                  choice =
                    track === "native"
                      ? contract.goal.toLowerCase().includes("append")
                        ? 1
                        : 0
                      : desired;
                else {
                  const prediction = await (
                    method === "initialized" ? initialized : trained
                  ).rank(
                    before,
                    available,
                    method === "frozen_context" ? undefined : history,
                    track === "native"
                      ? screenshotTensor(store.artifactRead(before.image!))
                      : undefined,
                  );
                  choice =
                    prediction.index === allowedIndices.length
                      ? skills.length
                      : allowedIndices[prediction.index];
                  inferenceMs = prediction.latencyMs;
                  inferenceTimes.push(inferenceMs);
                }
                choices.push(choice);
                if (choice === skills.length) {
                  abstentions++;
                  break;
                }
                const skill = skills[choice];
                if (
                  !skill ||
                  !skill.preconditions.every(
                    (predicate) => before.facts[predicate] === true,
                  ) ||
                  skill.effects.some(
                    (effect) => !contract.effects.includes(effect),
                  ) ||
                  skill.capabilities.some(
                    (capability) => !adapter.capabilities.includes(capability),
                  )
                )
                  break;
                const execution = { ...contract, method: skill.id };
                runtime.submit(execution, execution.id);
                await runtime.execute(execution.id);
                runs.push(execution.id);
                steps += skill.machine.states.reduce(
                  (sum, state) => sum + state.steps.length,
                  0,
                );
                if (store.run(execution.id).status !== "succeeded") break;
                if (track === "native" || choice === 0) {
                  claimed = true;
                  break;
                }
              }
              const actual =
                track === "native"
                  ? (
                      await (adapter as WindowsAdapter).client.call(
                        "fixture_text",
                        { handle },
                      )
                    ).text
                  : await (adapter as BrowserAdapter).page
                      .locator("#result")
                      .textContent();
              const success =
                actual === (track === "native" && role ? prefix + name : name);
              const record = {
                seed,
                method,
                episode,
                success,
                falseSuccess: claimed && !success,
                observations: capturedObservations - observationsBefore,
                elapsedMs: performance.now() - start,
                steps,
                abstentions,
                runs,
                choices,
                inferenceMs: inferenceTimes,
                decisionContexts,
                contextRetrieval:
                  "productionContext requester/host/session/target query at BEFORE timestamp",
                generativeCalls: 0,
                contextVersion: method === "frozen_context" ? 1 : 2,
                independentEvaluator:
                  track === "native"
                    ? "Win32 fixture_text via separate read"
                    : "public result DOM after execution",
                evidenceLevel:
                  track === "native"
                    ? "native desktop"
                    : "resettable live browser fixture",
              };
              records.push(record);
              appendFileSync(
                join(directory, "episodes.jsonl"),
                JSON.stringify(record) + "\n",
              );
              if (episode === episodes - 1)
                console.log(
                  JSON.stringify({
                    seed,
                    method,
                    track,
                    completed: episodes,
                    successes: records.filter(
                      (row) =>
                        row.seed === seed &&
                        row.method === method &&
                        row.success,
                    ).length,
                  }),
                );
            }
        } finally {
          await trained.close();
          await initialized.close();
        }
      }
      const sourceAfter = fingerprint();
      const changed = Object.keys(sourceBefore).filter(
        (path) => sourceAfter[path] !== sourceBefore[path],
      );
      const report = {
        schemaVersion: 1,
        id: protocol.id + "-" + track,
        protocolHash: hash(protocolBytes),
        track,
        scope:
          track === "native"
            ? protocol.nativeScope
            : "controlled form with current goal/history/budgets",
        learnedCapabilities: ["selection"],
        auxiliaryHeadTraining:
          "Predicate, recovery and outcome heads were not trained by this candidate and do not authorize execution or success",
        operational: JSON.parse(
          readFileSync(join(directory, "operational.json"), "utf8"),
        ),
        ...(track === "native"
          ? {
              nativeExecutableSha256: hash(
                readFileSync("native/target/release/disposable-editor.exe"),
              ),
              nativeBackend: "rust-win32-v1",
              nativePlatform: "Windows",
            }
          : {}),
        skillTemplates: skills.map((skill) =>
          hash(canonical({ ...skill, hash: "", compatibility: [] })),
        ),
        ...intervals(records),
        falseSuccess: records.filter((row) => row.falseSuccess).length,
        episodes: records.length,
        models: JSON.parse(
          readFileSync(join(directory, "training.json"), "utf8"),
        ),
        sourceHead,
        sourceBefore,
        sourceAfter,
        sourceStable: changed.length === 0,
        changedDuringEvaluation: changed,
        protectedBefore,
        protectedAfter: Object.fromEntries(
          protectedPaths.map((path) => [path, hash(readFileSync(path))]),
        ),
        candidateSelectionHash: hash(
          readFileSync(join(directory, "selection.json")),
        ),
        libraryBenefit:
          "Not established by this track; without_compilation holds primitive library identical",
        createdAt: new Date().toISOString(),
      };
      writeFileSync(
        join(directory, "results.json"),
        JSON.stringify(report, null, 2),
      );
      const issuerKeyPath = join(root, ".evaluator.key");
      if (!existsSync(issuerKeyPath))
        writeFileSync(issuerKeyPath, randomBytes(32), {
          flag: "wx",
          mode: 0o600,
        });
      const key = readFileSync(issuerKeyPath);
      if (key.length !== 32)
        throw new Error("Invalid private evaluator issuer key");
      const sealBody = {
        protocolHash: hash(protocolBytes),
        resultsHash: hash(readFileSync(join(directory, "results.json"))),
        episodesHash: hash(readFileSync(join(directory, "episodes.jsonl"))),
        sourceStable: report.sourceStable,
        createdAt: new Date().toISOString(),
      };
      writeFileSync(
        join(directory, "audit-sealed.json"),
        JSON.stringify(
          {
            ...sealBody,
            signature: createHmac("sha256", key)
              .update(canonical(sealBody))
              .digest("hex"),
          },
          null,
          2,
        ),
        { flag: "wx" },
      );
      console.log(
        JSON.stringify({
          track,
          learningBenefit: report.learningBenefit,
          falseSuccess: report.falseSuccess,
          episodes: report.episodes,
          sourceStable: report.sourceStable,
          paired: report.paired,
        }),
      );
      if (report.learningBenefit !== "PASS" || !report.sourceStable)
        process.exitCode = 1;
    } finally {
      await runtime.close();
      fixture?.kill();
    }
  } else
    throw new Error(
      "Usage: tsx evaluation/learning-followup.ts collect|train|audit native|browser [new-evidence-directory]",
    );
  for (const path of protectedPaths)
    if (hash(readFileSync(path)) !== protectedBefore[path])
      throw new Error("Protected original artifact changed: " + path);
} catch (error) {
  writeFileSync(
    join(directory, "failure-" + command + "-" + Date.now() + ".json"),
    JSON.stringify(
      {
        status: "FAIL",
        operation: command,
        track,
        error: String(error),
        sourceBefore,
        sourceAfter: fingerprint(),
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  throw error;
}
