import type {
  Action,
  Observation,
  RunEvent,
  TaskContract,
} from "../contracts/index.js";
import type { Store } from "../storage/index.js";
import { canonical, hash } from "../storage/index.js";

export const CONTEXT_VERSION = 2;
export const ADVISORY_CONTEXT_VERSION = 3;
export const VISUAL_CONTEXT_VERSION = 4;
const operations = [
  "fill",
  "click",
  "key",
  "scroll",
  "drag",
  "hold",
  "observe",
];
const clamp = (n: number) => Math.max(0, Math.min(1, n));

// This vocabulary-independent embedding contains the request, never its expected answer.
export function goalVector(goal: string): Float32Array {
  const vector = new Float32Array(8);
  const words = goal.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  for (const word of words.slice(0, 256)) {
    let value = 2166136261;
    for (const byte of Buffer.from(word))
      value = Math.imul(value ^ byte, 16777619) >>> 0;
    vector[value % 8] += value & 256 ? 1 : -1;
  }
  const length = Math.sqrt(vector.reduce((s, x) => s + x * x, 0)) || 1;
  for (let i = 0; i < vector.length; i++) vector[i] /= length;
  return vector;
}

export type EarlierAction = { action: Action; acknowledged: boolean };
export function earlierActions(
  events: RunEvent[],
  observation: Observation,
): EarlierAction[] {
  const actions: EarlierAction[] = [];
  const seen = new Set<string>();
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    if (event.type !== "experience" || event.at > observation.at) continue;
    const data = event.data as {
      action?: Action;
      before?: Observation;
      after?: Observation;
      receipt?: { actionId: string; phase: string };
    };
    if (
      !data.action ||
      !data.before ||
      !data.after ||
      !data.receipt ||
      data.before.at > data.after.at ||
      data.after.at > observation.at ||
      data.before.target !== observation.target ||
      data.before.host !== observation.host ||
      data.before.session !== observation.session ||
      data.after.target !== observation.target ||
      data.after.host !== observation.host ||
      data.after.session !== observation.session ||
      data.action.target !== observation.target ||
      data.action.host !== observation.host ||
      data.action.session !== observation.session ||
      data.receipt.actionId !== data.action.id ||
      seen.has(data.action.id)
    )
      continue;
    if (!["acknowledged", "effect_verified"].includes(data.receipt.phase))
      continue;
    seen.add(data.action.id);
    actions.push({ action: data.action, acknowledged: true });
  }
  return actions;
}

export function encodeContext(
  task: TaskContract,
  observation: Observation,
  previous: EarlierAction[],
  startAt = observation.at,
  spentActions = previous.filter((entry) => entry.action.runId === task.id)
    .length,
): Float32Array {
  const context = new Float32Array(36);
  const prior = previous
    .filter(
      (p) =>
        p.action.host === observation.host &&
        p.action.session === observation.session &&
        p.action.target === observation.target,
    )
    .slice(-2);
  prior.forEach((entry, index) => {
    const offset = (2 - prior.length + index) * 12;
    const operation = operations.indexOf(entry.action.operation);
    context[offset + (operation < 0 ? 7 : operation)] = 1;
    context[offset + 8] = Number(entry.acknowledged);
    context[offset + 9] = clamp(
      (entry.action.deadline - observation.at) / task.budgets.deadlineMs,
    );
    context[offset + 10] = clamp(
      task.effects.indexOf(entry.action.scope) >= 0 ? 1 : 0,
    );
    context[offset + 11] = 1;
  });
  context.set(goalVector(task.goal), 24);
  context[32] = clamp(task.effects.length / 32);
  context[33] = clamp(1 - spentActions / task.budgets.steps);
  context[34] = clamp(
    1 - Math.max(0, observation.at - startAt) / task.budgets.deadlineMs,
  );
  const facts = Object.values(observation.facts);
  context[35] = facts.length
    ? facts.filter((value) => typeof value === "boolean").length / facts.length
    : 0;
  return context;
}

// Both evaluation and deployment use this query. Global event pages stop at
// 5,000 rows and cannot supply recent history after long sessions.
export function productionContext(
  store: Store,
  task: TaskContract,
  observation: Observation,
  startAt?: number,
  version = CONTEXT_VERSION,
) {
  const predicate = `type='experience' AND at<=?
    AND json_extract(data,'$.after.at')<=?
    AND json_extract(data,'$.before.at')<=json_extract(data,'$.after.at')
    AND json_extract(data,'$.action.runId')=run_id
    AND json_extract(data,'$.action.host')=?
    AND json_extract(data,'$.action.session')=?
    AND json_extract(data,'$.action.target')=?
    AND json_extract(data,'$.action.requester')=?
    AND json_extract(data,'$.before.host')=json_extract(data,'$.action.host')
    AND json_extract(data,'$.before.session')=json_extract(data,'$.action.session')
    AND json_extract(data,'$.before.target')=json_extract(data,'$.action.target')
    AND json_extract(data,'$.after.host')=json_extract(data,'$.action.host')
    AND json_extract(data,'$.after.session')=json_extract(data,'$.action.session')
    AND json_extract(data,'$.after.target')=json_extract(data,'$.action.target')
    AND json_extract(data,'$.receipt.actionId')=json_extract(data,'$.action.id')
    AND json_extract(data,'$.receipt.phase') IN ('acknowledged','effect_verified')`;
  const bindings = [
    observation.at,
    observation.at,
    observation.host,
    observation.session,
    observation.target,
    task.requester,
  ];
  const rows = store.db
    .prepare(
      `SELECT * FROM events WHERE ${predicate} ORDER BY seq DESC LIMIT 2`,
    )
    .all(...bindings);
  const events = rows.map((row) => ({
    schemaVersion: 1,
    seq: Number(row.seq),
    runId: String(row.run_id),
    correlationId: String(row.correlation),
    at: Number(row.at),
    type: String(row.type),
    data: JSON.parse(String(row.data)),
  })) as RunEvent[];
  const previous = earlierActions(events, observation);
  const spent = store.db
    .prepare(
      `SELECT COUNT(DISTINCT json_extract(data,'$.action.id')) AS count FROM events WHERE ${predicate} AND run_id=?`,
    )
    .get(...bindings, task.id);
  const submitted = store.db
    .prepare(
      "SELECT MIN(at) AS at FROM events WHERE run_id=? AND type='submitted' AND at<=?",
    )
    .get(task.id, observation.at);
  const began =
    startAt ??
    (typeof submitted?.at === "number" ? submitted.at : observation.at);
  const basic = encodeContext(
    task,
    observation,
    previous,
    began,
    Number(spent?.count || 0),
  );
  return {
    previous,
    context: [ADVISORY_CONTEXT_VERSION, VISUAL_CONTEXT_VERSION].includes(
      version,
    )
      ? version === VISUAL_CONTEXT_VERSION
        ? visualContext(task, basic)
        : advisoryContext(task, basic, observation)
      : basic,
  };
}

// Public output-key structure and unresolved requirements are task inputs.
// Expected values and teacher choices never enter the selection context.
export function advisoryContext(
  task: TaskContract,
  basic: Float32Array,
  observation?: Observation,
) {
  if (basic.length !== 36)
    throw new Error("Advisory context requires a v2 base");
  const context = new Float32Array(48);
  context.set(basic);
  context[44] = clamp(task.unresolved.length / 8);
  context[45] =
    parseInt(
      hash(canonical(Object.keys(task.expected).sort())).slice(0, 8),
      16,
    ) / 0xffffffff;
  context[46] = clamp(Object.keys(task.expected).length / 32);
  context[47] =
    ["ready", "closed", "dialog"].reduce(
      (value, key, index) =>
        value +
        (typeof observation?.facts[key] === "boolean"
          ? observation.facts[key]
            ? 2
            : 1
          : 0) *
          3 ** index,
      0,
    ) / 26;
  return context;
}

export function visualContext(task: TaskContract, basic: Float32Array) {
  const context = advisoryContext(task, basic);
  context.fill(0, 45, 48);
  // This constant distinguishes visual-only state heads from v2 public-fact advice.
  context[47] = -1;
  return context;
}

export function visualStateContext(context: Float32Array) {
  if (context.length !== 48 || context[47] !== -1)
    throw new Error("Visual state heads require a contextVersion4 input");
  const state = new Float32Array(context);
  state.fill(0, 24, 32);
  state.fill(0, 36, 44);
  state.fill(0, 45, 47);
  return state;
}
