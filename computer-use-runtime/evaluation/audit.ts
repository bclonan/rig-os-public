import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { Store, hash } from "../src/storage/index.js";
import { Runtime } from "../src/runtime/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { seal, seedForm } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import { Recorder } from "../src/recorder/index.js";
import { compileDemonstrations } from "../src/compiler/experience.js";
import { Controller } from "../src/learner/index.js";
import type { SkillCapsule } from "../src/contracts/index.js";
const protocol = JSON.parse(readFileSync("acceptance.json", "utf8"));
mkdirSync("evidence", { recursive: true });
mkdirSync("skills", { recursive: true });
if (existsSync("evidence/audit-sealed.json"))
  throw new Error(
    "Audit already sealed. Keep the original results. A new audit requires a new protocol and evidence directory.",
  );
const protocolHash = hash(readFileSync("acceptance.json"));
writeFileSync("evidence/protocol.sha256", protocolHash);
const store = new Store(".data/audit-" + Date.now());
const adapter = await new BrowserAdapter(store, "audit-browser").start();
const runtime = new Runtime(store, adapter);
runtime.registry.put(seedForm());
const target = {
  host: adapter.host,
  session: adapter.session,
  identity: adapter.identity,
};
const recorder = new Recorder(store);
const demos = [];
const compilationStart = performance.now();
for (const name of ["Demo Iris 109", "Demo Juniper 211", "Demo Rowan 317"]) {
  await adapter.reset();
  const t = structuredTask("Set display name", target, { name });
  runtime.submit(t, t.id);
  await runtime.execute(t.id);
  if (store.run(t.id).status !== "succeeded")
    throw new Error("Demonstration failed");
  demos.push(recorder.capture(t.id));
}
const draft = compileDemonstrations(demos);
runtime.registry.put(draft);
const regressionIds: string[] = [];
for (const name of [
  "Regression Aspen",
  "Regression Birch",
  "Regression Cedar",
]) {
  await adapter.reset("ready", "shift");
  const task = structuredTask(
    "Validate compiled form",
    target,
    { name },
    draft.id,
  );
  const run = await runtime.testCandidate(task, draft);
  if (run.status !== "succeeded")
    throw new Error("Candidate regression failed: " + run.id);
  regressionIds.push(run.id);
}
runtime.registry.publish(draft.id, regressionIds);
const compiled = runtime.registry.get(draft.id);
const compilationMs = performance.now() - compilationStart;
writeFileSync("skills/form.compiled.json", JSON.stringify(compiled, null, 2));
writeFileSync("skills/form.seed.json", JSON.stringify(seedForm(), null, 2));
const repair = (id: string, locator: string, axis: number): SkillCapsule =>
  seal({
    ...seedForm(),
    id,
    description: "Local repair " + locator,
    inputs: {},
    outputs: [],
    capabilities: ["click"],
    preconditions: [],
    machine: {
      initial: "repair",
      states: [
        {
          id: "repair",
          steps: [
            {
              id: "repair",
              operation: "click",
              args: { locator },
              scope: "edit",
            },
          ],
          monitor: ["focused"],
        },
      ],
    },
    descriptor: Array.from({ length: 8 }, (_, i) => Number(i === axis)),
  });
const open = repair("repair.open", "open", 1),
  dismiss = repair("repair.dismiss", "dismiss", 2);
runtime.registry.put(open);
runtime.registry.put(dismiss);
const abstain = {
  ...seedForm(),
  id: "abstain",
  descriptor: [0, 0, 0, 1, 0, 0, 0, 0],
};
const records: any[] = [];
try {
  for (const seed of protocol.seeds) {
    const trained = await Controller.load(`models/${seed}/trained.onnx`);
    const initial = await Controller.load(`models/${seed}/initialized.onnx`);
    for (const method of protocol.methods) {
      const skills = [
        method === "without_compilation" ? seedForm() : compiled,
        open,
        dismiss,
        abstain,
      ];
      for (
        let episode = 0;
        episode < protocol.episodesPerMethodPerSeed;
        episode++
      ) {
        const mode = ["ready", "closed", "dialog", "both"][episode % 4],
          layout = episode % 3 === 0 ? "shift" : "base";
        await adapter.reset(mode, layout);
        const name =
          `Audit-${seed}-${episode}-` +
          hash(String(episode * 1709 + seed)).slice(0, 8);
        const start = performance.now();
        let steps = 0,
          observations = 0,
          inferenceMs = 0,
          claimed = false,
          abstentions = 0;
        const runs: string[] = [];
        const choices: number[] = [];
        while (steps < protocol.budgets.steps) {
          const o = await adapter.observe();
          observations++;
          let choice: number;
          if (method === "fixed")
            choice = o.facts.dialog ? 2 : o.facts.closed ? 1 : 0;
          else {
            const ranked = await (
              method === "initialized" ? initial : trained
            ).rank(o, skills);
            choice = ranked.index;
            inferenceMs += ranked.latencyMs;
          }
          choices.push(choice);
          if (choice === 3) {
            abstentions++;
            break;
          }
          const skill = skills[choice];
          // Deterministic permission and capability masks stay outside the learned scorer.
          if (
            skill.effects.some((e) => e !== "edit") ||
            skill.capabilities.some((c) => !adapter.capabilities.includes(c))
          )
            break;
          const task = structuredTask(
            "Set display name",
            target,
            { name },
            skill.id,
          );
          task.id = randomUUID();
          task.expected =
            choice === 0
              ? { result: name }
              : choice === 1
                ? { ready: true }
                : { dialog: false };
          runtime.submit(task, task.id);
          await runtime.execute(task.id);
          runs.push(task.id);
          steps += skill.machine.states.reduce((n, s) => n + s.steps.length, 0);
          const run = store.run(task.id);
          if (run.status !== "succeeded") break;
          if (choice === 0) {
            claimed = true;
            break;
          }
        }
        // Evaluator reads effects after the episode. The policy never receives this value.
        const actual = await adapter.page.locator("#result").textContent();
        const success = actual === name;
        const falseSuccess = claimed && !success;
        const events = runs.flatMap((id) => store.events(0, id));
        observations +=
          events.filter(
            (e) => e.type === "observation" || e.type === "verification",
          ).length + events.filter((e) => e.type === "experience").length;
        const record = {
          seed,
          method,
          episode,
          mode,
          layout,
          success,
          falseSuccess,
          abstentions,
          steps,
          observations,
          generativeCalls: 0,
          interventions: 0,
          recovery: success && mode !== "ready",
          inferenceMs,
          elapsedMs: performance.now() - start,
          runs,
          choices,
          evidenceLevel: "resettable live fixture",
        };
        records.push(record);
        appendFileSync(
          "evidence/episodes.jsonl",
          JSON.stringify(record) + "\n",
        );
      }
      console.log(
        JSON.stringify({
          seed,
          method,
          completed: 100,
          success: records.filter(
            (r) => r.seed === seed && r.method === method && r.success,
          ).length,
        }),
      );
    }
    await trained.close();
    await initial.close();
  }
  const grouped = protocol.seeds.flatMap((seed: number) =>
    protocol.methods.map((method: string) => {
      const r = records.filter((r) => r.seed === seed && r.method === method),
        p = r.filter((r) => r.success).length / r.length,
        z = 1.96,
        d = 1 + (z * z) / r.length,
        mid = (p + (z * z) / (2 * r.length)) / d,
        half =
          (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * r.length)) / r.length)) /
          d;
      return {
        seed,
        method,
        episodes: r.length,
        successRate: p,
        success95: [mid - half, mid + half],
        falseSuccess: r.filter((r) => r.falseSuccess).length,
        meanObservations: r.reduce((s, r) => s + r.observations, 0) / r.length,
        meanElapsedMs: r.reduce((s, r) => s + r.elapsedMs, 0) / r.length,
        meanInferenceMs: r.reduce((s, r) => s + r.inferenceMs, 0) / r.length,
        abstentions: r.reduce((s, r) => s + r.abstentions, 0),
      };
    }),
  );
  const paired = records
    .filter((r) => r.method === "trained")
    .map((a) => {
      const b = records.find(
        (b) =>
          b.method === "initialized" &&
          b.seed === a.seed &&
          b.episode === a.episode,
      )!;
      return {
        success: Number(a.success) - Number(b.success),
        observations: a.observations - b.observations,
      };
    });
  let rand = 90210;
  const random = () => {
    rand = (Math.imul(rand, 1664525) + 1013904223) >>> 0;
    return rand / 4294967296;
  };
  const bootstrap = { success: [] as number[], observations: [] as number[] };
  for (let j = 0; j < 2000; j++) {
    let s = 0,
      o = 0;
    for (let i = 0; i < paired.length; i++) {
      const p = paired[Math.floor(random() * paired.length)];
      s += p.success;
      o += p.observations;
    }
    bootstrap.success.push(s / paired.length);
    bootstrap.observations.push(o / paired.length);
  }
  for (const v of Object.values(bootstrap)) v.sort((a, b) => a - b);
  const success95 = [bootstrap.success[50], bootstrap.success[1949]],
    observations95 = [bootstrap.observations[50], bootstrap.observations[1949]];
  const falseSuccess = records.filter((r) => r.falseSuccess).length;
  const benefit =
    falseSuccess === 0 &&
    (success95[0] > 0 || (observations95[1] < 0 && success95[0] >= -0.02));
  const result = {
    protocolHash,
    evidenceLevel:
      "resettable live browser fixture; structured control with scoped visual features",
    learningBenefit: benefit ? "PASS" : "FAIL",
    falseSuccess,
    episodes: records.length,
    grouped,
    paired: { success95, observations95 },
    compilationMs,
    compiledHash: compiled.hash,
    models: JSON.parse(readFileSync("evidence/training.json", "utf8")),
    libraryBenefit:
      "No efficiency claim: competent seed and compiled form have the same operation count",
    nativeLearning: "UNVERIFIED",
    auditStore: store.root,
  };
  writeFileSync("evidence/results.json", JSON.stringify(result, null, 2));
  writeFileSync(
    "evidence/audit-sealed.json",
    JSON.stringify(
      {
        protocolHash,
        resultsHash: hash(JSON.stringify(result)),
        episodesHash: hash(readFileSync("evidence/episodes.jsonl")),
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      learningBenefit: result.learningBenefit,
      episodes: records.length,
      falseSuccess,
      success95,
    }),
  );
} finally {
  await runtime.close();
}
