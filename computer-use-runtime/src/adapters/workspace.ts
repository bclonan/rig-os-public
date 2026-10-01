import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { canonical, hash, type Store } from "../storage/index.js";
import {
  validate,
  type Action,
  type Observation,
  type Receipt,
  type TaskContract,
} from "../contracts/index.js";
import type { EnvironmentAdapter, ModelProvider } from "../contracts/ports.js";
import { Lease } from "../runtime/policy.js";
import {
  PermissionedTools,
  type ToolRequest,
  type WorkspaceGrant,
} from "../tools/index.js";
import {
  ArtifactConstructor,
  verifyArtifact,
  type ArtifactSpec,
} from "../assistant/artifact.js";

/** Scoped artifact tasks execute through the same durable coordinator and input lane. */
export class WorkspaceAdapter implements EnvironmentAdapter {
  readonly host = hostname();
  readonly session: string;
  readonly identity: string;
  readonly capabilities = [
    "research_read",
    "workspace_read",
    "workspace_write",
    "construct_artifact",
    "repair_artifact",
  ];
  readonly tools: PermissionedTools;
  readonly constructorAgent: ArtifactConstructor;
  // A bounded provider call can take 120s. This lease grants no foreground input.
  private readonly lease = new Lease(120000);
  private task?: TaskContract;
  private last?: Observation;
  private manual = false;
  constructor(
    private readonly store: Store,
    grant: WorkspaceGrant,
    provider: ModelProvider,
    spec: ArtifactSpec,
  ) {
    this.tools = new PermissionedTools(store, grant);
    this.constructorAgent = new ArtifactConstructor(
      store,
      this.tools,
      provider,
      spec,
    );
    this.session = "workspace-" + hash(this.tools.grant.root).slice(0, 20);
    this.identity = "artifact-" + this.constructorAgent.configHash;
  }
  async prepare(task: TaskContract) {
    if (
      task.target.host !== this.host ||
      task.target.session !== this.session ||
      task.target.identity !== this.identity ||
      task.parameters.configHash !== this.constructorAgent.configHash ||
      task.expected.artifactValid !== true
    )
      throw new Error(
        "Workspace task does not bind the trusted grant and frozen verifier",
      );
    const frozen = this.store.get<TaskContract>("artifact-contracts", task.id);
    if (frozen && canonical(frozen) !== canonical(task))
      throw new Error("Artifact task changed after freezing");
    if (!frozen) this.store.put("artifact-contracts", task.id, task);
    this.task = structuredClone(task);
    this.last = undefined;
  }
  async observe(signal?: AbortSignal): Promise<Observation> {
    signal?.throwIfAborted();
    const state = this.task
      ? this.store.get<{ output?: string; source?: string; attempts: number }>(
          "artifact-state",
          this.task.id,
        )
      : undefined;
    const source = this.task
      ? this.store.get<{ sourceHash: string; artifact: string }>(
          "artifact-sources",
          this.task.id,
        )
      : undefined;
    const facts: Record<string, string | number | boolean> = {
      focused: true,
      ready: !this.manual,
      sourceReady: Boolean(source),
      artifactValid: false,
      attempts: state?.attempts ?? 0,
      configHash: this.constructorAgent.configHash,
    };
    if (state?.output && source && this.task) {
      try {
        const actual = await this.tools.execute(
          {
            id: randomUUID(),
            runId: this.task.id,
            correlationId: this.task.correlationId,
            requester: this.task.requester,
            operation: "workspace_read",
            args: { path: this.constructorAgent.spec.outputPath },
            deadline: Date.now() + 5000,
          },
          signal,
        );
        const verification = verifyArtifact(
          this.constructorAgent.spec as ArtifactSpec,
          this.store.artifactRead(source.artifact),
          Buffer.from(actual.content),
        );
        facts.artifactValid = verification.valid;
        facts.verificationDiff = verification.diff;
        facts.outputHash = actual.sha256;
        facts.sourceHash = source.sourceHash;
        this.store.put("artifact-state", this.task.id, {
          ...state,
          outputHash: actual.sha256,
          output: actual.artifact,
          source: source.artifact,
          configHash: this.constructorAgent.configHash,
          diff: verification.valid ? undefined : verification.diff,
          verification,
        });
      } catch (error) {
        facts.verificationDiff =
          error instanceof Error
            ? error.message
            : "Output cannot be independently read";
      }
    }
    const observation: Observation = {
      schemaVersion: 1,
      id: randomUUID(),
      host: this.host,
      session: this.session,
      target: this.identity,
      at: Date.now(),
      revision: hash(canonical(facts)),
      frame: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
      focused: true,
      facts,
      features: [],
      backend: "permissioned-workspace-v1",
    };
    this.last = validate<Observation>("Observation", observation);
    return this.last;
  }
  async acquire(runId: string) {
    return this.lease.acquire(runId);
  }
  async execute(action: Action, signal?: AbortSignal): Promise<Receipt> {
    validate("Action", action);
    this.lease.check(action);
    if (
      !this.task ||
      action.runId !== this.task.id ||
      action.requester !== this.task.requester ||
      action.host !== this.host ||
      action.session !== this.session ||
      action.target !== this.identity ||
      !this.last ||
      action.observationId !== this.last.id ||
      action.revision !== this.last.revision ||
      Date.now() - this.last.at > 2000 ||
      JSON.stringify(action.frame) !== JSON.stringify(this.last.frame) ||
      Date.now() > action.deadline
    )
      throw new Error("Workspace action identity or observation is stale");
    if (!this.task.effects.includes(action.scope))
      throw new Error("Workspace action permission scope rejected");
    const expectedScope = ["construct_artifact", "repair_artifact"].includes(
      action.operation,
    )
      ? "workspace_write"
      : action.operation;
    if (action.scope !== expectedScope)
      throw new Error("Workspace operation does not bind its permission scope");
    if (
      ["construct_artifact", "repair_artifact"].includes(action.operation) &&
      (!this.task.effects.includes(
        this.constructorAgent.spec.source.operation,
      ) ||
        !this.task.effects.includes("workspace_read"))
    )
      throw new Error(
        "Artifact task requires explicit source and verification read scopes",
      );
    const context = {
      id: action.id,
      runId: action.runId,
      correlationId: this.task.correlationId,
      requester: action.requester,
      deadline: action.deadline,
    };
    const start = performance.now();
    const receipt = (phase: Receipt["phase"], detail: string): Receipt => ({
      schemaVersion: 1,
      actionId: action.id,
      runId: action.runId,
      phase,
      backend: "permissioned-workspace-v1",
      at: Date.now(),
      detail,
      timings: { dispatchMs: performance.now() - start },
    });
    try {
      signal?.throwIfAborted();
      if (
        action.operation === "construct_artifact" ||
        action.operation === "repair_artifact"
      ) {
        if (Object.keys(action.args).length)
          throw new Error(
            "Constructed candidates cannot change frozen criteria or grants",
          );
        await this.constructorAgent.construct(
          context,
          action.operation === "repair_artifact",
          signal,
        );
      } else {
        if (
          !["research_read", "workspace_read", "workspace_write"].includes(
            action.operation,
          )
        )
          throw new Error("Unregistered workspace operation");
        const spec = this.constructorAgent.spec;
        if (
          action.operation === "research_read" &&
          (spec.source.operation !== "research_read" ||
            action.args.url !== spec.source.location)
        )
          throw new Error("Research action differs from frozen source");
        if (
          action.operation === "workspace_read" &&
          ![
            spec.source.operation === "workspace_read"
              ? spec.source.location
              : undefined,
            spec.outputPath,
          ].includes(String(action.args.path))
        )
          throw new Error(
            "Workspace read differs from frozen source or output",
          );
        if (
          action.operation === "workspace_write" &&
          action.args.path !== spec.outputPath
        )
          throw new Error("Workspace write differs from frozen output path");
        const result = await this.tools.execute(
          {
            ...context,
            operation: action.operation as ToolRequest["operation"],
            args: action.args as ToolRequest["args"],
          },
          signal,
        );
        if (
          action.operation === spec.source.operation &&
          (result.source.location === spec.source.location ||
            action.args.url === spec.source.location)
        ) {
          const frozen = this.store.get<{ sourceHash: string }>(
            "artifact-sources",
            action.runId,
          );
          if (frozen && frozen.sourceHash !== result.sha256)
            throw new Error("Artifact source changed after freezing");
          this.store.put("artifact-sources", action.runId, {
            sourceHash: result.sha256,
            configHash: this.constructorAgent.configHash,
            artifact: result.artifact,
            provenance: result.source,
          });
        }
      }
      this.lease.check(action);
      return receipt(
        "acknowledged",
        "Scoped artifact operation completed; functional verification is separate",
      );
    } catch (error) {
      const dispatched = this.store
        .events(0, action.runId)
        .some(
          (event) =>
            event.type === "tool_dispatched" &&
            [
              action.id,
              hash(action.runId + ":" + action.id) + ".write",
            ].includes(String((event.data as { id?: string }).id)),
        );
      if (dispatched) throw error;
      return receipt(
        "rejected",
        error instanceof Error
          ? error.message
          : "Scoped artifact operation rejected",
      );
    }
  }
  async release(runId: string) {
    this.lease.release(runId);
  }
  async takeover() {
    this.manual = true;
    this.lease.takeover();
  }
  async returnControl() {
    this.manual = false;
    this.lease.returnControl();
  }
  async close() {
    if (this.task) this.lease.release(this.task.id);
  }
}
