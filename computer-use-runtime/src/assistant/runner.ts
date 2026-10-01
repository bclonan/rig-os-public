import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Runtime } from "../runtime/index.js";
import type { ExperienceStore, SkillRepository } from "../contracts/ports.js";
import { type Observation, type Action } from "../contracts/index.js";
import { canonical, hash } from "../util/canonical.js";
import {
  classifyDelivery,
  uncertainDelivery,
  UncertainDeliveryError,
} from "../contracts/delivery.js";
import { actionStep, type DesktopPlanner, type Decision } from "./planner.js";

export type Proposal = {
  id: string;
  decision: Decision;
  observation: Observation;
  createdAt: number;
};
export function observationFingerprint(o: Observation, decision: Decision) {
  if (["switch_window", "launch_app"].includes(decision.operation || "")) {
    return hash(
      canonical({
        host: o.host,
        session: o.session,
        target: o.target,
        destination:
          decision.operation === "switch_window"
            ? o.desktop?.windows.find((w) => w.id === decision.window)
            : o.desktop?.apps.find((a) => a.id === decision.app),
      }),
    );
  }
  const controls = o.controls
    ?.filter((c) => !c.offscreen)
    .map(({ focused, ...c }) => c);
  return hash(
    canonical({
      target: o.target,
      activeWindow: o.desktop?.activeWindow,
      frame: o.frame,
      handle: o.facts.windowHandle,
      title: o.facts.windowTitle,
      controls,
      focus: ["type", "key"].includes(decision.operation || "")
        ? o.controls?.filter((c) => c.focused).map((c) => c.index)
        : undefined,
      image:
        decision.control === undefined &&
        ["click", "drag"].includes(decision.operation || "")
          ? o.image
          : undefined,
    }),
  );
}

export async function driveDesktop<
  S extends ExperienceStore,
  R extends SkillRepository,
>(
  runtime: Runtime<S, R>,
  id: string,
  signal: AbortSignal,
  planner: DesktopPlanner,
) {
  let run = runtime.store.run(id);
  const deadline = Number(
    run.bindings.deadlineAt || Date.now() + run.contract.budgets.deadlineMs,
  );
  run.bindings.deadlineAt = deadline;
  run.status = "running";
  delete run.error;
  runtime.store.putRun(run);
  if (Date.now() >= deadline)
    throw new Error(
      "Task deadline reached. Start a new task with the remaining work.",
    );
  const boundedSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  ]);
  const proposal = run.bindings.proposal as Proposal | undefined;
  const approved = proposal && run.bindings.approvedProposal === proposal.id;
  let needsFreshObservation = false;
  let observation: Observation;
  await runtime.adapter.acquire(id);
  try {
    boundedSignal.throwIfAborted();
    await runtime.adapter.focus?.();
    await delay(150, undefined, { signal: boundedSignal });
    observation = await runtime.observe(run.contract, boundedSignal);
    runtime.event(run, "observation", { observation });
    if (approved) {
      delete run.bindings.approvedProposal;
      delete run.bindings.proposal;
      runtime.store.putRun(run);
      if (
        Date.now() - proposal.createdAt > 5 * 60_000 ||
        observationFingerprint(observation, proposal.decision) !==
          observationFingerprint(proposal.observation, proposal.decision)
      ) {
        runtime.event(run, "proposal_expired", {
          message:
            "The app changed after this action was proposed. Nothing was sent. Planning again.",
        });
      } else {
        if (
          run.cursor + Number(run.bindings.nonDeliveredAttempts || 0) >=
          run.contract.budgets.steps
        )
          throw new Error("Desktop action budget reached");
        const step = actionStep(
          proposal.decision,
          observation,
          run.contract.parameters.vision === true,
        );
        // Reacquire immediately before dispatch. Model calls and human review do
        // not extend the native lease or authorize a second action.
        const generation = await runtime.adapter.acquire(id);
        const action: Action = {
          schemaVersion: 1,
          id: randomUUID(),
          runId: id,
          requester: run.contract.requester,
          host: observation.host,
          session: observation.session,
          target: observation.target,
          observationId: observation.id,
          revision: observation.revision,
          frame: observation.frame,
          operation: step.operation,
          args: step.args,
          deadline: Math.min(deadline, Date.now() + 10_000),
          scope: step.scope,
          generation,
        };
        boundedSignal.throwIfAborted();
        runtime.event(run, "requested", action);
        runtime.policy.authorize(run.contract, action, observation);
        runtime.event(run, "authorized", {
          actionId: action.id,
          proposalId: proposal.id,
          source: "user_review",
        });
        runtime.event(run, "dispatched", action);
        let explicitlyRejected = false;
        try {
          const delivery = classifyDelivery(
            action,
            await runtime.adapter.execute(action, boundedSignal),
          );
          const receipt = delivery.receipt;
          if (delivery.kind === "not_dispatched") {
            explicitlyRejected = true;
            runtime.store.transaction(() => {
              run = runtime.store.run(id);
              run.bindings.nonDeliveredAttempts =
                Number(run.bindings.nonDeliveredAttempts || 0) + 1;
              runtime.store.putRun(run);
              runtime.event(run, "rejected", receipt);
            });
            needsFreshObservation = true;
            runtime.event(run, "proposal_expired", {
              actionId: action.id,
              dispatched: false,
              message:
                "The host rejected this action before sending input. Planning from a fresh observation. Review the new action before continuing.",
            });
          } else {
            runtime.event(run, "acknowledged", receipt);
            await delay(250, undefined, { signal: boundedSignal });
            const after = await runtime.observe(run.contract, boundedSignal);
            runtime.event(run, "observation", { observation: after });
            runtime.event(run, "experience", {
              before: observation,
              action,
              receipt,
              after,
            });
            runtime.event(run, "assistant_action", {
              operation: step.operation,
              args: step.args,
              window: observation.facts.windowTitle,
              nextWindow: after.facts.windowTitle,
              activeWindow: after.desktop?.activeWindow,
              target: observation.controls?.find(
                (c) => c.index === proposal.decision.control,
              )?.name,
              controlId: observation.controls?.find(
                (c) => c.index === proposal.decision.control,
              )?.id,
              result: after.controls
                ?.filter((c) => c.value || /result|expression/i.test(c.id))
                .map((c) => ({ name: c.name, value: c.value })),
            });
            // Persist the cursor even if cancellation arrives after delivery. Never replay it.
            run = runtime.store.run(id);
            run.cursor++;
            runtime.store.putRun(run);
            observation = after;
          }
        } catch (error) {
          if (explicitlyRejected) throw error;
          throw uncertainDelivery(
            "Uncertain desktop effect. Inspect the app before starting any new action. " +
              String(error),
            error,
            () =>
              runtime.event(run, "uncertain", {
                actionId: action.id,
                error: String(error),
              }),
          );
        }
      }
    }
  } finally {
    try {
      await runtime.adapter.release(id);
    } catch (error) {
      runtime.recordCleanupFailure(id, error);
      throw new UncertainDeliveryError(
        "Uncertain held input cleanup. Inspect the desktop before continuing. " +
          String(error),
        { cause: error },
      );
    }
  }
  boundedSignal.throwIfAborted();
  run = runtime.store.run(id);
  if (
    run.cursor + Number(run.bindings.nonDeliveredAttempts || 0) >=
    run.contract.budgets.steps
  )
    throw new Error(
      "Desktop action budget reached. Review the result or start a new task.",
    );
  if (needsFreshObservation) {
    observation = await runtime.observe(run.contract, boundedSignal);
    runtime.event(run, "observation", { observation });
  }
  const calls = Number(run.bindings.plannerCalls || 0) + 1;
  if (calls > run.contract.budgets.steps * 3)
    throw new Error("Planning budget reached");
  run.bindings.plannerCalls = calls;
  run.bindings.observation = observation!;
  runtime.store.putRun(run);
  runtime.event(run, "assistant_thinking", {
    model: run.contract.parameters.plannerModel,
    call: calls,
  });
  const history = runtime.store
    .events(0, id)
    .filter((e) =>
      [
        "assistant_action",
        "proposal_expired",
        "user_feedback",
        "pause",
        "restart",
      ].includes(e.type),
    )
    .map((e) => ({ type: e.type, data: e.data }));
  const decision = await planner.next(
    {
      ...run.contract,
      parameters: {
        ...run.contract.parameters,
        feedback: String(run.bindings.feedback || ""),
      },
    },
    observation!,
    history,
    boundedSignal,
  );
  boundedSignal.throwIfAborted();
  run = runtime.store.run(id);
  run.bindings.assistantMessage = decision.summary;
  delete run.bindings.proposal;
  if (decision.kind === "action") {
    actionStep(decision, observation!, run.contract.parameters.vision === true);
    const next: Proposal = {
      id: randomUUID(),
      decision,
      observation: observation!,
      createdAt: Date.now(),
    };
    run.bindings.proposal = next;
    run.status = "awaiting_approval";
    runtime.event(run, "assistant_proposed", {
      proposalId: next.id,
      decision,
      observation: observation!,
    });
  } else {
    // A model's assessment is not independent evidence of task completion.
    run.status =
      decision.kind === "question" ? "awaiting_input" : "needs_review";
    runtime.event(run, "assistant_answer", {
      ...decision,
      independentlyVerifiedCompletion: false,
    });
  }
  runtime.store.putRun(run);
}

export async function reviewDesktop<
  S extends ExperienceStore,
  R extends SkillRepository,
>(
  runtime: Runtime<S, R>,
  id: string,
  input: { command: string; proposalId?: string; feedback?: string },
) {
  const run = runtime.store.run(id);
  if (
    run.contract.method !== "desktop.assistant" &&
    !run.contract.method?.startsWith("drawing.")
  )
    throw new Error("Not a desktop assistant task");
  if (
    run.contract.method?.startsWith("drawing.") &&
    input.command !== "confirm"
  )
    throw new Error(
      "Create a new drawing plan to change this drawing; cancellation and pause use task controls",
    );
  if (
    [
      "running",
      "queued",
      "cancelled",
      "completed_by_user",
      "reconciliation_required",
    ].includes(run.status)
  )
    throw new Error("This task cannot accept a review in its current state");
  if (input.command === "approve") {
    const proposal = run.bindings.proposal as Proposal | undefined;
    if (
      run.status !== "awaiting_approval" ||
      !proposal ||
      input.proposalId !== proposal.id
    )
      throw new Error(
        "This action is no longer awaiting approval. Refresh the task.",
      );
    run.bindings.approvedProposal = proposal.id;
    runtime.event(run, "user_approved", {
      proposalId: proposal.id,
      decision: proposal.decision,
    });
  } else if (input.command === "continue") {
    if (
      typeof input.feedback !== "string" ||
      !input.feedback.trim() ||
      input.feedback.length > 4000
    )
      throw new Error("Add a short instruction before continuing");
    run.bindings.feedback =
      String(run.bindings.feedback || "").slice(-4000) +
      "\n" +
      input.feedback.trim();
    delete run.bindings.proposal;
    delete run.bindings.approvedProposal;
    runtime.event(run, "user_feedback", { text: input.feedback.trim() });
  } else if (input.command === "confirm") {
    if (
      !["needs_review", "awaiting_input", "blocked", "paused"].includes(
        run.status,
      )
    )
      throw new Error("Finish or pause the task before confirming the result");
    run.status = "completed_by_user";
    delete run.bindings.proposal;
    delete run.bindings.approvedProposal;
    runtime.store.putRun(run);
    runtime.event(run, "user_confirmed_completion", {
      independentlyVerifiedCompletion: false,
    });
    return run;
  } else throw new Error("Unknown desktop review command");
  run.status = "queued";
  runtime.store.putRun(run);
  void runtime.execute(id);
  return run;
}
