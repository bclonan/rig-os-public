import type { Run } from "../contracts/run.js";

export interface InvocationScope {
  id: string;
  hash: string;
  steps: number;
  retries: number;
}
interface InvocationBudget {
  hash: string;
  invocation: number;
  active: boolean;
  steps: number;
  retries: number;
  effects: number;
}

function budgets(run: Run): Record<string, InvocationBudget> {
  return (run.bindings.invocationBudgets ??= {}) as Record<
    string,
    InvocationBudget
  >;
}
function current(run: Run, scope: InvocationScope): InvocationBudget {
  const value = budgets(run)[scope.id];
  if (
    !value ||
    !value.active ||
    value.hash !== scope.hash ||
    ![value.invocation, value.steps, value.retries, value.effects].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    )
  )
    throw new Error(
      "Saved child invocation budget is unavailable. Reconcile or submit a new task.",
    );
  return value;
}

export function enterInvocation(run: Run, scope: InvocationScope) {
  const prior = budgets(run)[scope.id];
  if (prior?.active) throw new Error("Child invocation is already active");
  budgets(run)[scope.id] = {
    hash: scope.hash,
    invocation: (prior?.invocation || 0) + 1,
    active: true,
    steps: 0,
    retries: 0,
    effects: 0,
  };
}

/** Persist before an attempted child step. Rejected attempts also spend steps. */
export function chargeInvocationStep(run: Run, scopes: InvocationScope[]) {
  const values = scopes.map((scope) => ({ scope, value: current(run, scope) }));
  for (const { scope, value } of values)
    if (value.steps >= scope.steps)
      throw new Error("Child step budget exceeded: " + scope.id);
  for (const { value } of values) value.steps++;
}
export function canRetryInvocation(run: Run, scopes: InvocationScope[]) {
  return scopes.every((scope) => current(run, scope).retries < scope.retries);
}
export function chargeInvocationRetry(run: Run, scopes: InvocationScope[]) {
  if (!canRetryInvocation(run, scopes))
    throw new Error("Child retry budget exceeded");
  for (const scope of scopes) current(run, scope).retries++;
}
export function recordInvocationEffect(run: Run, scopes: InvocationScope[]) {
  for (const scope of scopes) current(run, scope).effects++;
}
export function invocationHasEffects(run: Run, scope: InvocationScope) {
  return current(run, scope).effects > 0;
}
/** Leaving a child for return or caller recovery never discards its spent budget. */
export function leaveInvocations(run: Run, nextScopes: InvocationScope[]) {
  if (!run.bindings.invocationBudgets) return;
  const retained = new Set(nextScopes.map((scope) => scope.id));
  for (const [id, value] of Object.entries(budgets(run)))
    if (value.active && !retained.has(id)) value.active = false;
}
