import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { Store, canonical, hash } from "../src/storage/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import {
  compileWorkflowLibrary,
  type WorkflowLibrary,
} from "../src/compiler/library.js";
import { Recorder, type Demonstration } from "../src/recorder/index.js";
import { seal, seedForm } from "../src/skills/index.js";
import { trainingPython } from "../src/learner/python.js";
import type { SkillCapsule, Step } from "../src/contracts/index.js";

const command = process.argv[2],
  root = resolve(process.argv[3] || "evidence/learning-followup-library-v1");
const protocolBytes = readFileSync(
  "evaluation/learning-followup-library.protocol.json",
);
const protocol = JSON.parse(protocolBytes.toString());
mkdirSync(root, { recursive: true });
const frozen = join(root, "protocol.json");
if (existsSync(frozen) && hash(readFileSync(frozen)) !== hash(protocolBytes))
  throw new Error("Frozen library protocol changed");
if (!existsSync(frozen)) writeFileSync(frozen, protocolBytes, { flag: "wx" });
const protectedBefore = Object.fromEntries(
  protocol.protected.map((path: string) => [path, hash(readFileSync(path))]),
);
function fingerprint() {
  const result = spawnSync(trainingPython(), ["scripts/source-identity.py"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("Library source identity failed");
  return {
    ...Object.fromEntries(
      JSON.parse(result.stdout).files.map(
        (file: { path: string; sha256: string }) => [file.path, file.sha256],
      ),
    ),
    "evaluation/learning-followup-library.protocol.json": hash(protocolBytes),
  };
}
const sourceBefore = fingerprint();
let capturedObservations = 0;
function teachers(): SkillCapsule[] {
  const form = seedForm();
  const operations = form.machine.states.flatMap((state) => state.steps);
  return [0, 1].map((role) =>
    seal({
      ...form,
      id: "library.teacher." + role,
      description: role
        ? "Inspect the authorized form and enter its display name"
        : "Enter the authorized display name",
      capabilities: role ? ["observe", "fill", "click"] : ["fill", "click"],
      machine: {
        initial: "macro",
        states: [
          {
            id: "macro",
            monitor: ["focused"],
            steps: [
              ...(role
                ? [
                    {
                      id: "inspect",
                      operation: "observe",
                      args: {},
                      scope: "edit",
                    } satisfies Step,
                  ]
                : []),
              ...operations,
            ],
          },
        ],
      },
    }),
  );
}
function primitives(teacher: SkillCapsule) {
  return teacher.machine.states
    .flatMap((state) => state.steps)
    .map((step, index) =>
      seal({
        ...teacher,
        id: teacher.id + ".primitive." + index,
        outputs: [
          step.operation === "fill"
            ? "name"
            : step.operation === "observe"
              ? "ready"
              : "result",
        ],
        capabilities: [step.operation],
        machine: {
          initial: "operation",
          states: [{ id: "operation", steps: [step], monitor: ["focused"] }],
        },
      }),
    );
}
function task(
  adapter: BrowserAdapter,
  name: string,
  skill: SkillCapsule,
  family: number,
) {
  const contract = structuredTask(
    family
      ? "Inspect and update the authorized form"
      : "Update the authorized form",
    {
      host: adapter.host,
      session: adapter.session,
      identity: adapter.identity,
    },
    { name },
    skill.id,
  );
  contract.expected = skill.outputs.includes("name")
    ? { name }
    : skill.outputs.includes("ready")
      ? { ready: true }
      : { result: name };
  return contract;
}
async function session(
  runtime: Runtime,
  adapter: BrowserAdapter,
  family: number,
  method: string,
  name: string,
  library: WorkflowLibrary,
  layout: string,
) {
  await adapter.reset("ready", layout);
  const teacher = teachers()[family],
    leaves = primitives(teacher);
  for (const skill of [teacher, ...leaves]) runtime.registry.put(skill);
  let steps = 0,
    claimed = false;
  const observationsBefore = capturedObservations;
  const actualOperations: string[] = [];
  const start = performance.now(),
    runs: string[] = [];
  const selections =
    method === "without_compilation"
      ? leaves
      : [method === "compiled" ? library.roots[family] : teacher];
  for (const skill of selections) {
    if (performance.now() - start >= protocol.budgets.episodeMs) break;
    const before = await adapter.observe();
    if (before.facts.ready !== true || before.facts.focused !== true) break;
    const contract = task(adapter, name, skill, family);
    contract.budgets.steps = Math.max(1, protocol.budgets.steps - steps);
    contract.budgets.deadlineMs = Math.max(
      1,
      protocol.budgets.episodeMs - Math.ceil(performance.now() - start),
    );
    const run =
      method === "compiled"
        ? await runtime.testCandidate(
            contract,
            skill,
            undefined,
            library.dependencies,
          )
        : (runtime.submit(contract, contract.id),
          await runtime.execute(contract.id),
          runtime.store.run(contract.id));
    runs.push(run.id);
    const events = runtime.store.events(0, run.id);
    const requested = events.filter((event) => event.type === "requested");
    steps += requested.length;
    actualOperations.push(
      ...requested.map(
        (event) => (event.data as { operation: string }).operation,
      ),
    );
    if (run.status !== "succeeded") break;
    if (skill.outputs.includes("result")) claimed = true;
  }
  const elapsedMs = performance.now() - start;
  const actual = await adapter.page.locator("#result").textContent(),
    success = actual === name;
  return {
    method,
    family,
    success,
    falseSuccess: claimed && !success,
    observations: capturedObservations - observationsBefore,
    steps,
    elapsedMs,
    decisions: runs.length,
    runs,
    generativeCalls: 0,
    evidenceLevel: "resettable live browser fixture",
    independentEvaluator: "Separate public result DOM read",
    primitiveSequence: actualOperations,
    expectedPrimitiveSequence: teacher.machine.states
      .flatMap((state) => state.steps)
      .map((step) => step.operation),
  };
}
type Episode = Awaited<ReturnType<typeof session>> & {
  seed: number;
  episode: number;
};
function paired(rows: Episode[], baseline: string) {
  const differences = rows
    .filter((row) => row.method === "compiled")
    .map((row) => {
      const other = rows.find(
        (other) =>
          other.seed === row.seed &&
          other.episode === row.episode &&
          other.method === baseline,
      )!;
      return {
        success: Number(row.success) - Number(other.success),
        observations: row.observations - other.observations,
      };
    });
  let random = protocol.uncertainty.bootstrapSeed;
  const successes: number[] = [],
    observations: number[] = [];
  for (
    let sample = 0;
    sample < protocol.uncertainty.bootstrapResamples;
    sample++
  ) {
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
const store = new Store(join(root, command + "-store")),
  adapter = await new BrowserAdapter(store, "library-" + command).start(),
  runtime = new Runtime(store, adapter);
const capture = adapter.observe.bind(adapter);
adapter.observe = (signal?: AbortSignal) => {
  capturedObservations++;
  return capture(signal);
};
try {
  if (command === "collect") {
    if (existsSync(join(root, "selection.json")))
      throw new Error("Library development is already frozen");
    const demos: Demonstration[] = [],
      candidates = teachers();
    for (const candidate of candidates) runtime.registry.put(candidate);
    for (let family = 0; family < candidates.length; family++)
      for (let example = 0; example < 3; example++) {
        await adapter.reset();
        const contract = task(
          adapter,
          "Development library " + family + " " + example,
          candidates[family],
          family,
        );
        runtime.submit(contract, contract.id);
        await runtime.execute(contract.id);
        if (store.run(contract.id).status !== "succeeded")
          throw new Error("Library teacher failed");
        demos.push(new Recorder(store).capture(contract.id));
      }
    const library = compileWorkflowLibrary(demos, "followup.library");
    writeFileSync(
      join(root, "demonstrations.json"),
      JSON.stringify(demos, null, 2),
      { flag: "wx" },
    );
    writeFileSync(
      join(root, "library.json"),
      JSON.stringify(library, null, 2),
      { flag: "wx" },
    );
    const validation = [];
    for (const method of protocol.methods)
      for (
        let episode = 0;
        episode < protocol.validationSessionsPerMethod;
        episode++
      )
        validation.push(
          await session(
            runtime,
            adapter,
            episode % 2,
            method,
            "Validation library " + method + " " + episode,
            library,
            episode % 2 ? "shift" : "base",
          ),
        );
    const selected = validation.every(
      (row) =>
        row.success &&
        !row.falseSuccess &&
        row.steps <= 8 &&
        row.elapsedMs < 15000,
    );
    writeFileSync(
      join(root, "selection.json"),
      JSON.stringify(
        {
          status: selected ? "PASS" : "FAIL",
          protocolHash: hash(protocolBytes),
          libraryHash: hash(readFileSync(join(root, "library.json"))),
          validation,
          sourceBefore,
          sourceAfter: fingerprint(),
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    console.log(
      JSON.stringify({
        status: selected ? "PASS" : "FAIL",
        demonstrations: demos.length,
        validation: validation.length,
        extraction: library.extractions,
      }),
    );
    if (!selected) process.exitCode = 1;
  } else if (command === "audit") {
    if (existsSync(join(root, "audit-sealed.json")))
      throw new Error("Library final evidence is sealed");
    const selectionBytes = readFileSync(join(root, "selection.json")),
      selection = JSON.parse(selectionBytes.toString()),
      libraryBytes = readFileSync(join(root, "library.json"));
    if (
      selection.status !== "PASS" ||
      selection.protocolHash !== hash(protocolBytes) ||
      selection.libraryHash !== hash(libraryBytes)
    )
      throw new Error("Unselected library bytes");
    const library = JSON.parse(libraryBytes.toString()) as WorkflowLibrary,
      records: Episode[] = [];
    for (const seed of protocol.seeds)
      for (const method of protocol.methods)
        for (
          let episode = 0;
          episode < protocol.episodesPerMethodPerSeed;
          episode++
        ) {
          const name =
            "Final library " +
            seed +
            " " +
            episode +
            " " +
            hash(hash(protocolBytes) + seed + ":" + episode).slice(0, 12);
          const row = {
            ...(await session(
              runtime,
              adapter,
              episode % 2,
              method,
              name,
              library,
              episode % 3 === 0 ? "shift" : "base",
            )),
            seed,
            episode,
          };
          records.push(row);
          appendFileSync(
            join(root, "episodes.jsonl"),
            JSON.stringify(row) + "\n",
          );
          if (episode === protocol.episodesPerMethodPerSeed - 1)
            console.log(
              JSON.stringify({ seed, method, completed: episode + 1 }),
            );
        }
    const primitiveComparison = paired(records, "without_compilation"),
      macroComparison = paired(records, "hand_authored_macro"),
      sourceAfter = fingerprint();
    const protectedAfter = Object.fromEntries(
      protocol.protected.map((path: string) => [
        path,
        hash(readFileSync(path)),
      ]),
    );
    const safe =
      records.length ===
        protocol.methods.length *
          protocol.seeds.length *
          protocol.episodesPerMethodPerSeed &&
      records.every(
        (row) =>
          !row.falseSuccess &&
          row.steps <= 8 &&
          row.elapsedMs < 15000 &&
          canonical(row.primitiveSequence) ===
            canonical(row.expectedPrimitiveSequence),
      ) &&
      canonical(sourceBefore) === canonical(sourceAfter) &&
      canonical(protectedBefore) === canonical(protectedAfter);
    const benefit =
      safe &&
      (primitiveComparison.success95[0] > 0 ||
        (primitiveComparison.observations95[1] < 0 &&
          primitiveComparison.success95[0] >= -0.02));
    const report = {
      schemaVersion: 1,
      status: benefit ? "PASS" : "FAIL",
      id: protocol.id,
      protocolHash: hash(protocolBytes),
      selectionHash: hash(selectionBytes),
      libraryHash: hash(libraryBytes),
      episodes: records.length,
      grouped: protocol.methods.map((method: string) => ({
        method,
        count: records.filter((row) => row.method === method).length,
        successes: records.filter((row) => row.method === method && row.success)
          .length,
        falseSuccess: records.filter(
          (row) => row.method === method && row.falseSuccess,
        ).length,
        observationsMean:
          records
            .filter((row) => row.method === method)
            .reduce((sum, row) => sum + row.observations, 0) / 300,
        elapsedMsMean:
          records
            .filter((row) => row.method === method)
            .reduce((sum, row) => sum + row.elapsedMs, 0) / 300,
      })),
      primitiveComparison,
      macroComparison,
      scopedLibraryBenefit: benefit ? "PASS" : "FAIL",
      sourceBefore,
      sourceAfter,
      sourceStable: canonical(sourceBefore) === canonical(sourceAfter),
      protectedBefore,
      protectedAfter,
      nonClaims: protocol.nonClaims,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(root, "results.json"), JSON.stringify(report, null, 2), {
      flag: "wx",
    });
    writeFileSync(
      join(root, "audit-sealed.json"),
      JSON.stringify(
        {
          protocolHash: hash(protocolBytes),
          resultsHash: hash(readFileSync(join(root, "results.json"))),
          episodesHash: hash(readFileSync(join(root, "episodes.jsonl"))),
          status: benefit ? "PASS" : "FAIL",
          sourceStable: report.sourceStable,
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    console.log(
      JSON.stringify({
        scopedLibraryBenefit: report.scopedLibraryBenefit,
        primitiveComparison,
        macroComparison,
        sourceStable: report.sourceStable,
      }),
    );
    if (!benefit) process.exitCode = 1;
  } else throw new Error("Use collect or audit");
} finally {
  await runtime.close();
}
