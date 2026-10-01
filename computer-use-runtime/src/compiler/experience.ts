import type { Demonstration } from "../recorder/index.js";
import type { SkillCapsule, Step } from "../contracts/index.js";
import { seal } from "../skills/index.js";
const signature = (s: Demonstration["steps"][number]) =>
  `${s.action.operation}:${s.action.args.locator || ""}`;
function lcs(a: string[], b: string[]): string[] {
  const table = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] =
        a[i] === b[j]
          ? 1 + table[i + 1][j + 1]
          : Math.max(table[i + 1][j], table[i][j + 1]);
  const out: string[] = [];
  let i = 0,
    j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return out;
}
export function compileDemonstrations(
  demos: Demonstration[],
  id = "form.compiled",
): SkillCapsule {
  if (demos.length < 3 || new Set(demos.map((d) => d.session)).size < 3)
    throw new Error("At least three independent demonstrations required");
  if (
    demos.some(
      (d) =>
        d.contract.target.identity !== demos[0].contract.target.identity ||
        d.contract.method !== demos[0].contract.method,
    )
  )
    throw new Error("Select demonstrations of the same method and target");
  if (
    demos.some(
      (d) => !d.verified || d.steps.some((s) => s.label !== "verified"),
    )
  )
    throw new Error(
      "Uncertain or failed demonstrations cannot become positives",
    );
  let aligned = demos[0].steps.map(signature);
  for (const d of demos.slice(1))
    aligned = lcs(aligned, d.steps.map(signature));
  if (aligned.length < 2)
    throw new Error("No repeated multi-operation subflow");
  const inputs: SkillCapsule["inputs"] = {};
  const steps: Step[] = [];
  const uncertainty: string[] = [];
  if (demos.some((d) => d.steps.length !== aligned.length))
    uncertainty.push(
      "Alignment omits demonstrated operations; review the missing effects before publication",
    );
  const positions = demos.map(() => 0);
  for (const [i, sig] of aligned.entries()) {
    const matched = demos.map((d, j) => {
      const index = d.steps.findIndex(
        (s, k) => k >= positions[j] && signature(s) === sig,
      );
      positions[j] = index + 1;
      return d.steps[index];
    });
    const first = matched[0].action;
    if (matched.some((step) => step.action.scope !== first.scope))
      throw new Error("Effect scopes disagree across aligned demonstrations");
    const args = { ...first.args };
    if (
      matched.some(
        (step) =>
          step.guard !== matched[0].guard || step.verify !== matched[0].verify,
      )
    )
      uncertainty.push(`Inconsistent guards or verification in ${sig}`);
    const keys = new Set(
      matched.flatMap((step) => Object.keys(step.action.args)),
    );
    for (const key of keys) {
      if (matched.some((step) => !Object.hasOwn(step.action.args, key)))
        throw new Error(
          `Argument presence disagrees across aligned demonstrations: ${sig}.${key}`,
        );
      const values = matched.map((m) => m.action.args[key]);
      if (new Set(values).size > 1) {
        const parameter = Object.keys(demos[0].contract.parameters).find((p) =>
          demos.every((d, j) => d.contract.parameters[p] === values[j]),
        );
        if (!parameter) {
          uncertainty.push(`Unexplained variation in ${sig}.${key}`);
          continue;
        }
        const t = typeof values[0];
        if (
          !["string", "number", "boolean"].includes(t) ||
          values.some((v) => typeof v !== t)
        )
          throw new Error("Inconsistent inferred type");
        inputs[parameter] = t as "string";
        args[key] = "$" + parameter;
      }
    }
    steps.push({
      id: "op" + i,
      operation: first.operation,
      args,
      scope: first.scope,
      alternatives: args.locator ? [String(args.locator)] : [],
      ...(matched[0].guard ? { guard: matched[0].guard } : {}),
      ...(matched[0].verify ? { verify: matched[0].verify } : {}),
    });
  }
  if (!Object.keys(inputs).length)
    throw new Error("Compilation found no parameter variation");
  // Segment at observable effect boundaries, not timestamps or fixed replay coordinates.
  const states = steps.map((step, i) => ({
    id: "segment" + i,
    steps: [step],
    ...(i + 1 < steps.length ? { next: "segment" + (i + 1) } : {}),
    monitor: ["focused"],
  }));
  return seal({
    schemaVersion: 1,
    id,
    version: "1.0.0",
    hash: "",
    description:
      "Parameterized form workflow extracted from aligned independent demonstrations",
    status: "draft",
    inputs,
    outputs: Object.keys(demos[0].contract.expected),
    capabilities: [...new Set(steps.map((s) => s.operation))],
    preconditions: [],
    effects: [...new Set(steps.map((s) => s.scope))],
    machine: { initial: "segment0", states },
    recovery: ["fresh_observation", "probe_ready", "repair_local", "escalate"],
    budgets: { retries: 1, steps: steps.length + 4 },
    dependencies: [],
    compatibility: [demos[0].contract.target.identity],
    descriptor: [1, 0, 0, 0, 0, 0, 0, 0],
    provenance: {
      kind: "compiled",
      demonstrations: demos.map((d) => d.id),
      tests: [],
      uncertain: uncertainty,
    },
  });
}
