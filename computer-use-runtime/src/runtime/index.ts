import { createActor, createMachine, fromPromise } from "xstate";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  EnvironmentAdapter,
  EvidenceVerifier,
  PermissionPolicy,
  ExperienceStore,
  SkillRepository,
} from "../contracts/ports.js";
import {
  validate,
  type TaskContract,
  type Action,
  type SkillCapsule,
  type Receipt,
  type Observation,
  type PredicateEvidence,
} from "../contracts/index.js";
import type { Store } from "../storage/index.js";
import type { Run } from "../contracts/run.js";
import { hash, canonical } from "../util/canonical.js";
import { Registry } from "../skills/index.js";
import { Policy } from "./policy.js";
import { fact, guardPass, ObjectiveVerifier } from "../predicates/index.js";
import { driveDesktop } from "../assistant/runner.js";
import { type DesktopPlanner } from "../assistant/planner.js";
import { compileProgram, type ProgramStep } from "./program.js";
import { assessEffectEvidence } from "./effect-evidence.js";
import {
  classifyDelivery,
  uncertainDelivery,
  UncertainDeliveryError,
} from "../contracts/delivery.js";
import {
  canRetryInvocation,
  chargeInvocationRetry,
  chargeInvocationStep,
  enterInvocation,
  invocationHasEffects,
  leaveInvocations,
  recordInvocationEffect,
} from "./invocations.js";
export class Runtime<
  S extends ExperienceStore = Store,
  R extends SkillRepository = Registry,
> {
  readonly registry: R;
  private work = new Map<
    string,
    { abort: AbortController; promise: Promise<void> }
  >();
  private draftTests = new Map<string, string>();
  private draftDependencies = new Map<string, Set<string>>();
  private preparations = new Map<string, () => Promise<void>>();
  private lane: Promise<void> = Promise.resolve();
  private closing = false;
  private closePromise?: Promise<void>;
  private cleanupErrors = new Map<string, unknown>();
  private shutdownFailures: unknown[] = [];
  constructor(
    readonly store: S,
    readonly adapter: EnvironmentAdapter,
    readonly verifier: EvidenceVerifier = new ObjectiveVerifier(),
    readonly policy: PermissionPolicy = new Policy(),
    readonly selector?: (
      task: TaskContract,
      observation: import("../contracts/index.js").Observation,
      registry: NoInfer<R>,
    ) => Promise<SkillCapsule>,
    readonly desktopPlanner?: DesktopPlanner,
    ...repository: Registry extends R ? [repository?: R] : [repository: R]
  ) {
    this.registry = repository[0] ?? (new Registry(store) as unknown as R);
    this.store.transaction(() => {
      for (const run of this.store.runs()) {
        if (
          run.bindings.cleanupFailed === true ||
          ["running", "waiting", "verifying_cleanup"].includes(run.status)
        ) {
          const previousStatus = run.status;
          if (
            ["running", "waiting", "verifying_cleanup"].includes(run.status)
          ) {
            run.status = "reconciliation_required";
            run.error =
              "Coordinator restarted with unconfirmed input cleanup. Manually inspect the host and use Return control before reconciling effects.";
          }
          run.bindings.cleanupFailed = true;
          run.bindings.cleanupRequiresReturn = true;
          this.store.putRun(run);
          this.event(run, "restart", {
            previousStatus,
            cleanupUnconfirmed: true,
            noAutomaticReplay: true,
          });
        }
      }
    });
  }
  event(run: Run, type: string, data: unknown) {
    return this.store.append(run.id, type, data, run.contract.correlationId);
  }
  async configureEnvironment<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing || this.work.size)
      throw new Error("Pause active tasks before changing desktop permission");
    const promise = this.lane.then(operation);
    this.lane = promise.then(
      () => {},
      () => {},
    );
    return promise;
  }
  private assertCleanupReady(run: Run, excludeOwn = false) {
    const failed = this.store
      .runs()
      .filter(
        (previous) =>
          (!excludeOwn || previous.id !== run.id) &&
          (previous.bindings.cleanupFailed === true ||
            this.cleanupErrors.has(previous.id)) &&
          previous.contract.target.host === run.contract.target.host &&
          previous.contract.target.session === run.contract.target.session,
      );
    if (!failed.length) return;
    this.event(run, "cleanup_quarantined", {
      failedRunIds: failed.map((previous) => previous.id),
      host: run.contract.target.host,
      session: run.contract.target.session,
      noAutomaticReplay: true,
    });
    throw new Error(
      "Input cleanup is unconfirmed for this host and session. Manually inspect the host, then use Return control or reconcile the original cleanup failure before requesting another action.",
    );
  }
  recordCleanupFailure(id: string, error: unknown) {
    if (!this.cleanupErrors.has(id)) this.cleanupErrors.set(id, error);
    const run = this.store.run(id);
    run.status = "reconciliation_required";
    run.error =
      "Input cleanup failed. Manually inspect the host and release held input before any new action. " +
      String(error);
    run.bindings.cleanupFailed = true;
    try {
      this.store.transaction(() => {
        this.store.putRun(run);
        this.event(run, "cleanup_failed", {
          error: String(error),
          applicationResult: run.bindings.verifiedApplicationResult,
          noAutomaticReplay: true,
        });
      });
    } catch (journalError) {
      // Keep the quarantine durable when the journal alone failed. Never report
      // a successful journal commit or discard either persistence error.
      try {
        this.store.putRun(run);
      } catch (checkpointError) {
        throw new AggregateError(
          [journalError, checkpointError],
          "Cleanup journal and quarantine checkpoint failed: " +
            String(journalError) +
            "; " +
            String(checkpointError),
          { cause: journalError },
        );
      }
      throw journalError;
    }
  }
  async returnControl() {
    return this.configureEnvironment(async () => {
      const scopes = this.adapter.cleanupScopes?.() ?? [
        { host: this.adapter.host, session: this.adapter.session },
      ];
      await this.adapter.returnControl();
      const acknowledged: string[] = [];
      this.store.transaction(() => {
        for (const run of this.store.runs()) {
          if (
            (run.bindings.cleanupFailed !== true &&
              !this.cleanupErrors.has(run.id)) ||
            !scopes.some(
              (scope) =>
                scope.host === run.contract.target.host &&
                scope.session === run.contract.target.session,
            )
          )
            continue;
          delete run.bindings.cleanupFailed;
          delete run.bindings.cleanupRequiresReturn;
          this.store.putRun(run);
          this.event(run, "human_return_acknowledged", {
            priorStatus: run.status,
            cleanupError: this.cleanupErrors.has(run.id)
              ? String(this.cleanupErrors.get(run.id))
              : run.error,
            noAutomaticReplay: true,
          });
          acknowledged.push(run.id);
        }
      });
      for (const id of acknowledged) this.cleanupErrors.delete(id);
    });
  }
  private async releaseForReconciliation(run: Run) {
    try {
      await this.adapter.release(run.id);
    } catch (error) {
      this.recordCleanupFailure(run.id, error);
      throw error;
    }
    delete run.bindings.cleanupFailed;
    delete run.bindings.cleanupRequiresReturn;
    this.store.putRun(run);
    this.cleanupErrors.delete(run.id);
  }
  async observe(
    task: TaskContract,
    signal?: AbortSignal,
  ): Promise<Observation> {
    const observation = validate<Observation>(
      "Observation",
      await this.adapter.observe(signal),
    );
    if (
      observation.host !== task.target.host ||
      observation.host !== this.adapter.host ||
      observation.session !== task.target.session ||
      observation.session !== this.adapter.session ||
      observation.target !== task.target.identity ||
      observation.target !== this.adapter.identity
    )
      throw new Error(
        "Observation does not bind the authorized host, session and target",
      );
    if (
      !Number.isFinite(observation.at) ||
      Date.now() - observation.at > 2000 ||
      observation.at > Date.now() + 250
    )
      throw new Error("Observation timestamp is stale or invalid");
    return observation;
  }
  async testCandidate(
    task: TaskContract,
    skill: SkillCapsule,
    prepare?: () => Promise<void>,
    dependencies: SkillCapsule[] = [],
  ) {
    if (
      !["browser-fixture-v1", "documentation-fixture-v1"].includes(
        task.target.identity,
      ) ||
      skill.effects.some((e) => e !== "edit")
    )
      throw new Error(
        "Candidate tests require the resettable local fixture and edit-only permissions",
      );
    if (
      dependencies.some(
        (dependency) =>
          !skill.dependencies.includes(dependency.id) ||
          dependency.effects.some((effect) => !task.effects.includes(effect)),
      )
    )
      throw new Error(
        "Candidate dependency is outside the declared test scope",
      );
    for (const dependency of dependencies) this.registry.put(dependency);
    this.registry.put(skill);
    this.draftTests.set(task.id, skill.hash);
    this.draftDependencies.set(
      task.id,
      new Set(dependencies.map((dependency) => dependency.hash)),
    );
    try {
      const run = this.submit({ ...task, method: skill.id }, task.id);
      run.bindings.skillHash = skill.hash;
      this.store.putRun(run);
      if (prepare) this.preparations.set(run.id, prepare);
      await this.execute(run.id);
      return this.store.run(run.id);
    } finally {
      this.draftTests.delete(task.id);
      this.draftDependencies.delete(task.id);
      this.preparations.delete(task.id);
    }
  }
  submit(value: unknown, idempotencyKey: string): Run {
    if (this.closing) throw new Error("Runtime is shutting down");
    const task = validate<TaskContract>("TaskContract", value);
    const old = this.store.dedup(idempotencyKey, task);
    if (old) return this.store.run(old);
    if (this.store.runs().some((r) => r.id === task.id))
      throw new Error("Duplicate run ID");
    const run: Run = {
      id: task.id,
      contract: structuredClone(task),
      status:
        task.unresolved.length ||
        task.requirements.some(
          (requirement) => requirement.origin === "unresolved",
        )
          ? "awaiting_input"
          : "queued",
      cursor: 0,
      skill: task.method || "form.seed",
      model: this.store.get<string>("model", "active") || "fixed",
      bindings: { target: task.target.identity },
    };
    this.store.transaction(() => {
      this.store.putRun(run);
      this.store.remember(idempotencyKey, task, run.id);
      this.event(run, "submitted", { contract: task });
    });
    return run;
  }
  execute(id: string): Promise<void> {
    if (this.closing)
      return Promise.reject(new Error("Runtime is shutting down"));
    const old = this.work.get(id);
    if (old) return old.promise;
    const abort = new AbortController();
    const promise = this.lane
      .then(() => this.drive(id, abort.signal))
      .finally(() => this.work.delete(id));
    this.lane = promise.catch(() => {});
    this.work.set(id, { abort, promise });
    return promise;
  }
  private pinnedSkill(id: string, versions: Record<string, string>) {
    const skill = versions[id]
      ? this.registry.version(versions[id])
      : this.registry.get(id);
    if (skill.id !== id) throw new Error("Pinned skill identity mismatch");
    versions[id] = skill.hash;
    return skill;
  }
  private async drive(id: string, signal: AbortSignal) {
    let run = this.store.run(id);
    if (!["queued", "reconciled"].includes(run.status)) return;
    let generation = 0;
    let inFlight: Promise<void> | undefined;
    try {
      signal.throwIfAborted();
      this.assertCleanupReady(run);
      await this.preparations.get(id)?.();
      signal.throwIfAborted();
      await this.adapter.prepare?.(run.contract);
      if (run.contract.method === "desktop.assistant") {
        if (!this.desktopPlanner)
          throw new Error("Desktop assistant is not configured");
        await driveDesktop(this, id, signal, this.desktopPlanner);
        return;
      }
      if (run.skill === "auto") {
        if (!this.selector)
          throw new Error("Adaptive selector is not configured");
        const observed = await this.observe(run.contract, signal);
        const selected = await this.selector(
          run.contract,
          observed,
          this.registry,
        );
        this.registry.put(selected);
        run.skill = selected.id;
        this.store.putRun(run);
        this.event(run, "skill_selected", {
          skill: selected.id,
          hash: selected.hash,
          observation: observed,
        });
      }
      const versions = (run.bindings.skillVersions || {}) as Record<
        string,
        string
      >;
      if (run.bindings.skillHash)
        versions[run.skill] = String(run.bindings.skillHash);
      const skill = this.pinnedSkill(run.skill, versions);
      if (
        !["seed", "published"].includes(skill.status) &&
        this.draftTests.get(run.id) !== skill.hash
      )
        throw new Error("Skill is not published");
      if (!skill.compatibility.includes(this.adapter.identity))
        throw new Error("Skill environment compatibility rejected");
      if (skill.effects.some((e) => !run.contract.effects.includes(e)))
        throw new Error("Skill permission scope rejected");
      for (const c of skill.capabilities)
        if (!this.adapter.capabilities.includes(c))
          throw new Error(`Missing capability ${c}`);
      for (const [k, t] of Object.entries(skill.inputs))
        if (typeof run.contract.parameters[k] !== t)
          throw new Error(`Invalid parameter ${k}`);
      const program = compileProgram(
        skill,
        run.contract,
        this.adapter.capabilities,
        (id) => this.pinnedSkill(id, versions),
        this.draftTests.get(run.id),
        this.draftDependencies.get(run.id),
      );
      const stepBudget = Math.min(
        skill.budgets.steps,
        run.contract.budgets.steps,
      );
      const initial = run.bindings.programComplete
        ? undefined
        : typeof run.bindings.programNode === "string"
          ? run.bindings.programNode
          : run.cursor
            ? program.legacyOrder[run.cursor]
            : program.initial;
      if (initial && !program.nodes.has(initial))
        throw new Error("Saved program state is unavailable");
      generation = await this.adapter.acquire(id);
      run.status = "running";
      run.bindings.skillHash = skill.hash;
      run.bindings.skillVersions = versions;
      this.store.putRun(run);
      const deadline = Number(
        run.bindings.deadlineAt || Date.now() + run.contract.budgets.deadlineMs,
      );
      run.bindings.deadlineAt = deadline;
      this.store.putRun(run);
      if (Date.now() >= deadline) throw new Error("Run deadline expired");
      signal = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      ]);
      this.event(run, "started", { skillHash: skill.hash, model: run.model });
      if (run.cursor === 0 && skill.preconditions.length) {
        const entry = await this.observe(run.contract, signal);
        this.event(run, "preconditions", {
          observation: entry,
          predicates: skill.preconditions,
        });
        for (const predicate of skill.preconditions)
          if (!guardPass(fact(entry, predicate), entry))
            throw new Error(`Required precondition ${predicate} is not TRUE`);
      }
      const checkpoint = (next?: string) => {
        delete run.wakeAt;
        run.bindings.programNode = next;
        run.bindings.programComplete = !next;
        leaveInvocations(
          run,
          next ? program.nodes.get(next)!.budgetScopes : [],
        );
        this.store.putRun(run);
        return next;
      };
      const checkMonitors = (
        node: ProgramStep,
        observation: import("../contracts/index.js").Observation,
      ) => {
        for (const predicate of node.monitors)
          if (!guardPass(fact(observation, predicate), observation))
            throw new Error(`Required monitor ${predicate} is not TRUE`);
      };
      const doStep = async (node: ProgramStep): Promise<string | undefined> => {
        signal.throwIfAborted();
        run = this.store.run(id);
        if (!["running"].includes(run.status))
          throw new Error("Run interrupted");
        if (Date.now() > deadline) throw new Error("Run deadline");
        const visits = Number(run.bindings.programVisits || 0) + 1;
        if (visits > stepBudget * 4 + program.nodes.size)
          throw new Error("Control-flow budget exceeded");
        run.bindings.programVisits = visits;
        run.bindings.programNode = node.key;
        this.store.putRun(run);
        const step = node.step;
        if (node.call?.phase === "return" && !node.call.verify)
          return checkpoint(node.next);
        if (
          !step &&
          !node.branches.length &&
          !node.monitors.length &&
          !node.call
        )
          return checkpoint(node.next);
        if (
          !node.call &&
          run.cursor + Number(run.bindings.nonDeliveredAttempts || 0) >=
            stepBudget
        )
          throw new Error("Step budget exceeded");
        if (
          (step || node.branches.length) &&
          !(step?.operation === "wait" && run.wakeAt !== undefined)
        ) {
          chargeInvocationStep(run, node.budgetScopes);
          this.store.putRun(run);
        }
        let dispatched = false;
        let knownFailedEffect = false;
        let failureEvidence:
          | { evidence: PredicateEvidence[]; observation: Observation }
          | undefined;
        let rejectedAttemptCharged = false;
        let rejectionPersistenceFailed = false;
        try {
          if (node.call?.phase === "return")
            dispatched = invocationHasEffects(run, node.call.scope);
          if (
            node.call?.phase === "enter" &&
            !node.call.guard &&
            !node.monitors.length
          ) {
            enterInvocation(run, node.call.scope);
            return checkpoint(node.next);
          }
          if (step?.operation === "wait") {
            run.wakeAt =
              run.wakeAt ??
              Date.now() + (step.waitMs ?? (step.waitFor ? 5000 : 100));
            this.store.putRun(run);
            this.event(run, "waiting", {
              wakeAt: run.wakeAt,
              predicate: step.waitFor,
              node: node.key,
            });
            do {
              if (node.monitors.length || step.waitFor || step.guard) {
                const observation = await this.observe(run.contract, signal);
                checkMonitors(node, observation);
                if (
                  step.guard &&
                  !guardPass(fact(observation, step.guard), observation)
                )
                  throw new Error(`Required guard ${step.guard} is not TRUE`);
                if (
                  step.waitFor &&
                  guardPass(fact(observation, step.waitFor), observation)
                ) {
                  this.event(run, "wait_satisfied", {
                    predicate: step.waitFor,
                    observation,
                  });
                  break;
                }
              }
              if (Date.now() >= run.wakeAt) {
                if (step.waitFor)
                  throw new Error(`Wait expired without ${step.waitFor}`);
                break;
              }
              await delay(
                Math.min(100, Math.max(1, run.wakeAt - Date.now())),
                undefined,
                { signal },
              );
            } while (true);
            signal.throwIfAborted();
            run.cursor++;
            return checkpoint(node.next);
          }
          const before = await this.observe(run.contract, signal);
          signal.throwIfAborted();
          this.event(run, "observation", {
            phase: "before",
            observation: before,
          });
          if (node.call?.phase === "return") {
            const evidence = [...node.monitors, node.call.verify!].map(
              (predicate) => fact(before, predicate),
            );
            failureEvidence = { evidence, observation: before };
            this.event(run, "subskill_verification", {
              node: node.key,
              skillHash: node.call.scope.hash,
              observation: before,
              evidence,
            });
            const assessment = assessEffectEvidence(evidence, before);
            knownFailedEffect = assessment.knownFailure;
            if (!assessment.verified) {
              if (dispatched && !knownFailedEffect)
                throw uncertainDelivery(
                  "Uncertain subskill effect. Reconcile before any retry.",
                  new Error("Subskill return predicate is unresolved"),
                  () =>
                    this.event(run, "uncertain", {
                      node: node.key,
                      reason: "Subskill return predicate is unresolved",
                    }),
                );
              throw new Error(`Subskill effect ${node.call.verify} unverified`);
            }
            return checkpoint(node.next);
          }
          checkMonitors(node, before);
          if (node.call?.phase === "enter") {
            if (
              node.call.guard &&
              !guardPass(fact(before, node.call.guard), before)
            )
              throw new Error(`Required guard ${node.call.guard} is not TRUE`);
            enterInvocation(run, node.call.scope);
            this.event(run, "subskill_entered", {
              node: node.key,
              skillHash: node.call.scope.hash,
              guard: node.call.guard,
            });
            return checkpoint(node.next);
          }
          if (!step) {
            if (!node.branches.length) return checkpoint(node.next);
            const next =
              node.branches.find((branch) =>
                guardPass(fact(before, branch.guard), before),
              )?.target || node.next;
            if (!next)
              throw new Error(
                "No transition guard is TRUE and no default transition exists",
              );
            this.event(run, "transition", {
              node: node.key,
              next,
              observation: before,
            });
            run.cursor++;
            return checkpoint(next);
          }
          if (step.guard && !guardPass(fact(before, step.guard), before))
            throw new Error(`Required guard ${step.guard} is not TRUE`);
          const a: Action = {
            schemaVersion: 1,
            id: randomUUID(),
            runId: id,
            requester: run.contract.requester,
            host: this.adapter.host,
            session: this.adapter.session,
            target: this.adapter.identity,
            observationId: before.id,
            revision: before.revision,
            frame: before.frame,
            operation: step.operation,
            args: step.args,
            deadline: Math.min(
              deadline,
              Date.now() +
                (["construct_artifact", "repair_artifact"].includes(
                  step.operation,
                )
                  ? 120000
                  : 10000),
            ),
            scope: step.scope,
            generation,
          };
          this.event(run, "requested", a);
          this.policy.authorize(run.contract, a, before);
          this.event(run, "authorized", { actionId: a.id });
          signal.throwIfAborted();
          this.event(run, "dispatched", { actionId: a.id });
          dispatched = true;
          let receipt: Receipt;
          let after: Observation;
          let explicitlyRejected = false;
          try {
            const delivery = classifyDelivery(
              a,
              await this.adapter.execute(a, signal),
            );
            receipt = delivery.receipt;
            if (delivery.kind === "not_dispatched") {
              explicitlyRejected = true;
              dispatched = false;
              try {
                this.store.transaction(() => {
                  run = this.store.run(id);
                  run.bindings.nonDeliveredAttempts =
                    Number(run.bindings.nonDeliveredAttempts || 0) + 1;
                  this.store.putRun(run);
                  this.event(run, "rejected", receipt);
                });
              } catch (error) {
                rejectionPersistenceFailed = true;
                throw new Error(
                  "Could not persist rejected attempt. " + String(error),
                );
              }
              rejectedAttemptCharged = true;
              signal.throwIfAborted();
              if (
                receipt.dispatched === false &&
                node.freshObservationRecovery
              ) {
                const attempts = Number(run.bindings.recoveryAttempts || 0);
                if (
                  attempts < skill.budgets.retries &&
                  canRetryInvocation(run, node.budgetScopes) &&
                  run.cursor + Number(run.bindings.nonDeliveredAttempts) <
                    stepBudget
                ) {
                  run.bindings.recoveryAttempts = attempts + 1;
                  chargeInvocationRetry(run, node.budgetScopes);
                  const next = checkpoint(node.key);
                  this.event(run, "preflight_recovery", {
                    node: node.key,
                    next,
                    actionId: a.id,
                    attempt: attempts + 1,
                    nonDeliveredAttempts: run.bindings.nonDeliveredAttempts,
                    receipt,
                    dispatched: false,
                  });
                  return next;
                }
              }
              throw new Error(`Host rejected action: ${receipt.detail}`);
            }
            this.event(run, "acknowledged", receipt);
            if (step.operation !== "observe") {
              recordInvocationEffect(run, node.budgetScopes);
              this.store.putRun(run);
            }
            after = await this.observe(run.contract, signal);
          } catch (e) {
            if (explicitlyRejected) throw e;
            throw uncertainDelivery(
              "Uncertain dispatch. Reconcile before any retry. " + String(e),
              e,
              () =>
                this.event(run, "uncertain", {
                  actionId: a.id,
                  error: String(e),
                }),
            );
          }
          const effectEvidence = [
            ...node.monitors,
            ...(step.verify ? [step.verify] : []),
          ].map((predicate) => fact(after, predicate));
          failureEvidence = { evidence: effectEvidence, observation: after };
          const assessment = assessEffectEvidence(effectEvidence, after);
          knownFailedEffect = assessment.knownFailure;
          this.event(run, "experience", {
            before,
            action: a,
            receipt,
            after,
            guard: step.guard,
            verify: step.verify,
            skillHash: skill.hash,
            model: run.model,
            label: knownFailedEffect
              ? "failure"
              : assessment.unresolved
                ? "unknown"
                : "unassessed",
          });
          if (knownFailedEffect)
            this.event(run, "effect_failed", {
              actionId: a.id,
              observation: after,
              evidence: effectEvidence,
            });
          checkMonitors(node, after);
          if (step.verify && !guardPass(fact(after, step.verify), after))
            throw new Error(`Step effect ${step.verify} unverified`);
          this.event(run, step.verify ? "effect_verified" : "step_observed", {
            actionId: a.id,
            scope: step.verify || "operation acknowledged only",
            completion: false,
          });
          signal.throwIfAborted();
          run.cursor++;
          return checkpoint(node.next);
        } catch (error) {
          // Journaling may take long enough for an earlier FALSE to expire.
          if (failureEvidence)
            knownFailedEffect = assessEffectEvidence(
              failureEvidence.evidence,
              failureEvidence.observation,
            ).knownFailure;
          if (
            dispatched &&
            (!knownFailedEffect || signal.aborted) &&
            !(error instanceof UncertainDeliveryError)
          ) {
            const effectError = error;
            error = uncertainDelivery(
              "Uncertain effect. Reconcile before any retry. " +
                String(effectError),
              effectError,
              () =>
                this.event(run, "uncertain", {
                  node: node.key,
                  error: String(effectError),
                  reason:
                    "Acknowledged input has no safe persisted continuation",
                }),
            );
          }
          if (error instanceof UncertainDeliveryError) throw error;
          signal.throwIfAborted();
          const recoveries = Number(run.bindings.recoveryAttempts || 0);
          const retryScopes = node.recovery
            ? program.nodes.get(node.recovery)!.budgetScopes
            : [];
          if (
            (dispatched && !knownFailedEffect) ||
            rejectionPersistenceFailed ||
            !node.recovery ||
            !canRetryInvocation(run, retryScopes) ||
            recoveries >= skill.budgets.retries
          )
            throw error;
          run.bindings.recoveryAttempts = recoveries + 1;
          chargeInvocationRetry(run, retryScopes);
          if (!rejectedAttemptCharged) run.cursor++;
          this.event(run, "recovery", {
            node: node.key,
            next: node.recovery,
            attempt: recoveries + 1,
            error: String(error),
            dispatched,
            knownFailedEffect,
          });
          return checkpoint(node.recovery);
        }
      };
      const verifyCompletion = async (): Promise<string | undefined> => {
        signal.throwIfAborted();
        run = this.store.run(id);
        if (run.status !== "running") throw new Error("Run interrupted");
        let observation = await this.observe(run.contract, signal);
        let evidence = this.verifier.verify(run.contract, observation);
        const verificationDeadline = Math.min(deadline, Date.now() + 1500);
        while (
          evidence.length &&
          evidence.some((e) => !guardPass(e, observation)) &&
          Date.now() < verificationDeadline
        ) {
          this.event(run, "verification_pending", { observation, evidence });
          await delay(50, undefined, { signal });
          observation = await this.observe(run.contract, signal);
          evidence = this.verifier.verify(run.contract, observation);
        }
        signal.throwIfAborted();
        this.event(run, "verification", { observation, evidence });
        const complete =
          evidence.length > 0 &&
          evidence.every(
            (e) => guardPass(e, observation) && e.kind === "completion",
          );
        const knownFailure =
          evidence.some((e) => e.truth === "FALSE") &&
          evidence.every(
            (e) =>
              e.kind === "completion" &&
              e.truth !== "UNKNOWN" &&
              e.scope === observation.target &&
              e.observationId === observation.id &&
              e.expiresAt >= Date.now(),
          );
        const attempts = Number(run.bindings.recoveryAttempts || 0);
        if (
          !complete &&
          knownFailure &&
          program.verificationRecovery &&
          attempts < skill.budgets.retries &&
          run.cursor + Number(run.bindings.nonDeliveredAttempts || 0) <
            stepBudget
        ) {
          const signature = hash(
            canonical(
              evidence
                .map((e) => ({
                  predicate: e.predicate,
                  truth: e.truth,
                  detector: e.detector,
                }))
                .concat([{ facts: observation.facts }] as any),
            ),
          );
          const prior = (run.bindings.verificationFailures || []) as string[];
          if (!prior.includes(signature)) {
            run.bindings.verificationFailures = [...prior, signature];
            run.bindings.recoveryAttempts = attempts + 1;
            this.event(run, "verification_recovery", {
              next: program.verificationRecovery,
              attempt: attempts + 1,
              failureSignature: signature,
              observation,
              evidence,
            });
            return checkpoint(program.verificationRecovery);
          }
          run.error =
            "Repair made no progress. Inspect verification evidence before submitting a revised task.";
        }
        run.status = complete ? "verifying_cleanup" : "blocked";
        if (complete)
          run.bindings.verifiedApplicationResult = {
            observationId: observation.id,
            at: Date.now(),
          };
        run.bindings.observation = observation;
        if (complete) delete run.error;
        else
          run.error ||= knownFailure
            ? "Independent verification disproved completion. Repair budget or an explicit recovery handler is unavailable."
            : "Completion remains unknown. Inspect the latest observation and verifier before taking another action.";
        this.store.putRun(run);
        return undefined;
      };
      // XState owns branches and nested continuations; a parallel deadline monitor can stop any node.
      const stateMap: Record<string, any> = {};
      const stateIds = new Map(
        [...program.nodes.keys()].map((key, index) => [key, "s" + index]),
      );
      for (const [key, node] of program.nodes)
        stateMap[stateIds.get(key)!] = {
          invoke: {
            src: fromPromise(() => {
              const next = doStep(node);
              inFlight = next.then(
                () => {},
                () => {},
              );
              return next;
            }),
            onDone: [
              ...[
                ...new Set(
                  [
                    node.key,
                    node.next,
                    node.recovery,
                    ...node.branches.map((branch) => branch.target),
                  ].filter((target): target is string => Boolean(target)),
                ),
              ].map((target) => ({
                guard: ({ event }: any) => event.output === target,
                target: stateIds.get(target)!,
                reenter: true,
              })),
              { target: "complete" },
            ],
            onError: {
              target: "#execution.failed",
              actions: ({ event }: any) => {
                throwError = event.error;
              },
            },
          },
        };
      stateMap.complete = {
        invoke: {
          src: fromPromise(() => {
            const verification = verifyCompletion();
            inFlight = verification.then(
              () => {},
              () => {},
            );
            return verification;
          }),
          onDone: [
            ...(program.verificationRecovery
              ? [
                  {
                    guard: ({ event }: any) =>
                      event.output === program.verificationRecovery,
                    target: stateIds.get(program.verificationRecovery)!,
                    reenter: true,
                  },
                ]
              : []),
            { target: "verified" },
          ],
          onError: {
            target: "#execution.failed",
            actions: ({ event }: any) => {
              throwError = event.error;
            },
          },
        },
      };
      stateMap.verified = { type: "final" };
      let throwError: unknown;
      const machine = createMachine({
        id: "execution",
        initial: "active",
        states: {
          active: {
            type: "parallel",
            states: {
              work: {
                initial: initial ? stateIds.get(initial)! : "complete",
                states: stateMap,
                onDone: "#execution.done",
              },
              monitor: {
                initial: "watching",
                states: {
                  watching: {
                    after: {
                      [Math.max(1, deadline - Date.now())]: {
                        target: "#execution.failed",
                        actions: () => {
                          throwError = new Error("Deadline exceeded");
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          done: { type: "final" },
          failed: { type: "final" },
        },
      });
      const actor = createActor(machine);
      await new Promise<void>((res, rej) => {
        const stop = () => {
          actor.stop();
          rej(signal.reason || new Error("Run interrupted"));
        };
        signal.addEventListener("abort", stop, { once: true });
        actor.subscribe({
          complete: () => {
            signal.removeEventListener("abort", stop);
            res();
          },
          error: rej,
        });
        actor.start();
      });
      if (throwError) throw throwError;
      signal.throwIfAborted();
      run = this.store.run(id);
    } catch (e) {
      run = this.store.run(id);
      if (
        run.bindings.cleanupFailed !== true &&
        (e instanceof UncertainDeliveryError ||
          !["paused", "cancelled"].includes(run.status))
      ) {
        run.status =
          e instanceof UncertainDeliveryError
            ? "reconciliation_required"
            : "blocked";
        run.error = String(e);
        this.store.putRun(run);
      }
      this.event(run, "interrupted", { status: run.status, error: String(e) });
    } finally {
      await inFlight?.catch(() => {});
      try {
        if (generation) await this.adapter.release(id);
        run = this.store.run(id);
        if (run.status === "verifying_cleanup") {
          run.status = run.contract.method?.startsWith("drawing.")
            ? "needs_review"
            : "succeeded";
          this.store.putRun(run);
          this.event(run, "completed", { status: run.status });
        }
      } catch (error) {
        this.recordCleanupFailure(id, error);
      }
    }
  }
  async control(
    id: string,
    command: "pause" | "resume" | "cancel" | "reconcile",
  ) {
    if (!["pause", "resume", "cancel", "reconcile"].includes(command))
      throw new Error("Unknown control command");
    const run = this.store.run(id);
    if (["succeeded", "cancelled", "completed_by_user"].includes(run.status))
      throw new Error("A finished task cannot change state");
    if (command === "pause" || command === "cancel") {
      delete run.bindings.approvedProposal;
      delete run.bindings.proposal;
      run.status =
        command === "cancel"
          ? "cancelled"
          : run.status === "reconciliation_required" ||
              run.bindings.cleanupFailed === true ||
              this.cleanupErrors.has(id)
            ? "reconciliation_required"
            : "paused";
      this.store.putRun(run);
      this.work.get(id)?.abort.abort();
      await this.work.get(id)?.promise;
      try {
        await this.adapter.release(id);
      } catch (error) {
        this.recordCleanupFailure(id, error);
        throw error;
      }
      this.event(run, command, {});
      return this.store.run(id);
    }
    if (command === "reconcile") {
      if (this.work.size)
        throw new Error("Pause active work before reconciliation");
      if (
        run.bindings.cleanupFailed === true &&
        run.bindings.cleanupRequiresReturn === true
      )
        throw new Error(
          "Input cleanup is unconfirmed after restart. Manually inspect the host and use Return control before reconciling this task. A fresh worker cannot acknowledge the previous worker's held input.",
        );
      const releasedCleanup =
        run.bindings.cleanupFailed === true || this.cleanupErrors.has(id);
      if (releasedCleanup) await this.releaseForReconciliation(run);
      this.assertCleanupReady(run, true);
      if (run.contract.method === "desktop.assistant") {
        if (!releasedCleanup) await this.releaseForReconciliation(run);
        run.status = "awaiting_input";
        delete run.bindings.proposal;
        delete run.bindings.approvedProposal;
        run.error =
          "Inspect the app, then describe the remaining work. No interrupted action will be repeated automatically.";
        this.store.putRun(run);
        return run;
      }
      await this.adapter.prepare?.(run.contract);
      const o = await this.observe(run.contract);
      const evidence = this.verifier.verify(run.contract, o);
      this.event(run, "reconciled", { observation: o, evidence });
      if (
        evidence.length &&
        evidence.every((p) => p.kind === "completion" && guardPass(p, o))
      ) {
        if (!releasedCleanup) await this.releaseForReconciliation(run);
        run.status = run.contract.method?.startsWith("drawing.")
          ? "needs_review"
          : "succeeded";
        delete run.error;
      } else {
        run.status = "awaiting_input";
        run.error =
          "Effect remains uncertain. Inspect evidence and submit a new task; automatic retry is forbidden.";
      }
      this.store.putRun(run);
      return run;
    }
    if (run.status === "reconciliation_required") return run;
    if (run.status !== "paused")
      throw new Error("Only a paused run can resume");
    if (
      run.bindings.cleanupFailed === true ||
      this.cleanupErrors.has(id) ||
      this.store
        .events(0, id)
        .some((e) =>
          ["uncertain", "restart", "cleanup_failed"].includes(e.type),
        )
    ) {
      run.status = "reconciliation_required";
      this.store.putRun(run);
      return run;
    }
    run.status = "queued";
    this.store.putRun(run);
    void this.execute(id);
    return this.store.run(id);
  }
  async recover() {
    for (const r of this.store.runs())
      if (["running", "waiting", "verifying_cleanup"].includes(r.status)) {
        r.status = "reconciliation_required";
        r.bindings.cleanupFailed = true;
        r.bindings.cleanupRequiresReturn = true;
        r.error =
          "Coordinator restarted with unconfirmed input cleanup. Manually inspect the host and use Return control before reconciling effects.";
        this.store.putRun(r);
        this.event(r, "restart", {});
      }
  }
  private throwFailures(failures: unknown[], operation: string) {
    const unique = [...new Set(failures)];
    if (unique.length === 1) throw unique[0];
    if (unique.length)
      throw new AggregateError(
        unique,
        operation + " failed: " + unique.map(String).join("; "),
        { cause: unique[0] },
      );
  }
  private async drainOwned(ids: string[]) {
    const owned = new Map(this.work);
    const controls = await Promise.allSettled(
      ids.map(async (id) => {
        const active = owned.get(id);
        if (
          active &&
          ["succeeded", "cancelled", "completed_by_user"].includes(
            this.store.run(id).status,
          )
        ) {
          await active.promise;
          return;
        }
        await this.control(id, "pause");
      }),
    );
    // A rejected control must not leave another run's finally writing to a closed store.
    const work = await Promise.allSettled(
      [...owned.values()].map((entry) => entry.promise),
    );
    return [...controls, ...work].flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
  }
  async takeover() {
    const ids = new Set([
      ...this.work.keys(),
      ...this.store
        .runs()
        .filter((r) =>
          ["queued", "running", "awaiting_approval"].includes(r.status),
        )
        .map((r) => r.id),
    ]);
    const failures = await this.drainOwned([...ids]);
    for (const id of ids) {
      if (this.cleanupErrors.has(id)) failures.push(this.cleanupErrors.get(id));
    }
    try {
      await this.adapter.takeover();
    } catch (error) {
      failures.push(error);
    }
    this.throwFailures(failures, "Takeover");
  }
  async pauseForShutdown() {
    this.closing = true;
    this.shutdownFailures.push(
      ...(await this.drainOwned([...this.work.keys()])),
    );
    this.throwFailures(this.shutdownFailures, "Shutdown drain");
  }
  close() {
    return (this.closePromise ||= (async () => {
      const failures: unknown[] = [];
      try {
        await this.pauseForShutdown();
      } catch (error) {
        failures.push(error);
      }
      failures.push(...this.cleanupErrors.values());
      try {
        await this.adapter.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        this.store.close();
      } catch (error) {
        failures.push(error);
      }
      this.throwFailures(failures, "Runtime shutdown");
    })());
  }
}
