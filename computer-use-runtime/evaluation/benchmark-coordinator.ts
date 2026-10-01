import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  BenchmarkEnvironmentAdapter,
  type BenchmarkGrant,
} from "../src/adapters/benchmark.js";
import { Runtime } from "../src/runtime/index.js";
import { Store, canonical } from "../src/storage/index.js";
import {
  validate,
  type SkillCapsule,
  type TaskContract,
} from "../src/contracts/index.js";
import type { DesktopPlanner } from "../src/assistant/planner.js";
import { LocalDesktopPlanner } from "../src/assistant/local.js";

export interface BenchmarkCoordinatorConfiguration {
  storeDirectory: string;
  grant: BenchmarkGrant;
  /** Trusted local configuration only. Benchmark task_config/reward/evaluator are never available here. */
  task: (instruction: string, target: TaskContract["target"]) => TaskContract;
  skills?: SkillCapsule[];
  planner?: DesktopPlanner;
}

export class BenchmarkCoordinator {
  readonly store: Store;
  readonly adapter: BenchmarkEnvironmentAdapter;
  readonly runtime: Runtime;
  private active?: {
    id: string;
    instruction: string;
    work: Promise<void>;
    error?: string;
  };
  constructor(
    private readonly configuration: BenchmarkCoordinatorConfiguration,
  ) {
    this.store = new Store(resolve(configuration.storeDirectory));
    this.adapter = new BenchmarkEnvironmentAdapter(
      this.store,
      configuration.grant,
    );
    this.runtime = new Runtime(
      this.store,
      this.adapter,
      undefined,
      undefined,
      undefined,
      configuration.planner || new LocalDesktopPlanner(this.store),
    );
    for (const skill of configuration.skills || [])
      this.runtime.registry.put(skill);
  }
  async request(value: unknown): Promise<unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid private benchmark request");
    const request = value as Record<string, unknown>;
    if (
      typeof request.id !== "string" ||
      request.id.length > 128 ||
      !["reset", "next_action", "close"].includes(String(request.method))
    )
      throw new Error("Invalid private benchmark request identity");
    if (request.method === "close") {
      await this.close();
      return { closed: true };
    }
    if (
      request.host !== this.adapter.host ||
      request.session !== this.adapter.session
    )
      throw new Error(
        "Private benchmark request changed its trusted host/session",
      );
    if (request.method === "reset") {
      if (this.active) {
        const run = this.store.run(this.active.id);
        if (
          !["succeeded", "cancelled", "completed_by_user"].includes(run.status)
        )
          await this.runtime.control(run.id, "cancel");
        await this.active.work;
      }
      await this.adapter.reset();
      this.active = undefined;
      return { reset: true };
    }
    if (
      Object.keys(request).some(
        (key) =>
          ![
            "id",
            "method",
            "host",
            "session",
            "instruction",
            "observation",
            "pending",
          ].includes(key),
      )
    )
      throw new Error(
        "Private benchmark request contains evaluator or unsupported fields",
      );
    if (
      typeof request.instruction !== "string" ||
      !request.instruction.trim() ||
      request.instruction.length > 8192
    )
      throw new Error("Invalid benchmark instruction");
    if (this.active && request.instruction !== this.active.instruction)
      throw new Error("Reset before changing the benchmark instruction");
    this.adapter.receive(
      request.observation,
      request.pending,
      this.adapter.host,
      this.adapter.session,
    );
    if (!this.active) {
      const target = {
        host: this.adapter.host,
        session: this.adapter.session,
        identity: this.adapter.identity,
      };
      const task = validate<TaskContract>(
        "TaskContract",
        this.configuration.task(request.instruction, target),
      );
      if (
        task.goal !== request.instruction ||
        canonical(task.target) !== canonical(target) ||
        !Object.keys(task.expected).length
      )
        throw new Error(
          "Trusted task must bind the instruction, target and independently measurable completion criteria",
        );
      const run = this.runtime.submit(task, task.id);
      const active = {
        id: run.id,
        instruction: request.instruction,
        work: Promise.resolve(),
      } as NonNullable<BenchmarkCoordinator["active"]>;
      this.active = active;
      active.work = this.runtime.execute(run.id).catch((error) => {
        active.error = String(error);
      });
    }
    const until = Date.now() + 750;
    while (Date.now() < until) {
      const dispatch = this.adapter.poll();
      if (dispatch) return dispatch;
      const run = this.store.run(this.active.id);
      if (run.status === "succeeded")
        return {
          operation: "done",
          args: {},
          phase: "verified",
          runId: run.id,
        };
      if (
        [
          "blocked",
          "failed",
          "cancelled",
          "reconciliation_required",
          "awaiting_input",
          "awaiting_approval",
        ].includes(run.status)
      )
        return {
          operation: "fail",
          args: {},
          phase: run.status,
          runId: run.id,
          reason:
            run.error ||
            this.active.error ||
            "Runtime requires intervention; the benchmark is not verified complete",
        };
      await delay(10);
    }
    return {
      operation: "wait",
      args: {},
      phase: "observation_required",
      runId: this.active.id,
    };
  }
  private closePromise?: Promise<void>;
  close() {
    this.closePromise ||= this.runtime
      .close()
      .finally(() => this.store.close());
    return this.closePromise;
  }
}

async function* boundedLines() {
  const max = 9 * 1024 * 1024;
  let pending = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([
      pending,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    let newline: number;
    while ((newline = pending.indexOf(10)) >= 0) {
      if (newline > max)
        throw new Error("Private benchmark request exceeds byte limit");
      yield pending.subarray(0, newline).toString("utf8");
      pending = pending.subarray(newline + 1);
    }
    if (pending.length > max)
      throw new Error("Private benchmark request exceeds byte limit");
  }
  if (pending.length)
    throw new Error(
      "Private benchmark input ended mid-request; outstanding input is never replayed",
    );
}

/** Private child stdio only. No HTTP endpoint, VM provisioning, benchmark evaluator, or score is assumed. */
export async function serveBenchmarkCoordinator(
  configuration: BenchmarkCoordinatorConfiguration,
) {
  const coordinator = new BenchmarkCoordinator(configuration);
  let closing = false;
  const close = async () => {
    if (!closing) {
      closing = true;
      await coordinator.close();
    }
  };
  process.once("SIGINT", () => {
    void close();
    process.stdin.destroy();
  });
  process.once("SIGTERM", () => {
    void close();
    process.stdin.destroy();
  });
  try {
    for await (const line of boundedLines()) {
      let request: any;
      try {
        if (Buffer.byteLength(line) > 9 * 1024 * 1024)
          throw new Error("Private benchmark request exceeds byte limit");
        request = JSON.parse(line);
        const result = await coordinator.request(request);
        process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
        if (request.method === "close") break;
      } catch (error) {
        process.stdout.write(
          JSON.stringify({ id: request?.id, error: String(error) }) + "\n",
        );
      }
    }
  } finally {
    await close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv[2] !== "--config" || !process.argv[3])
    throw new Error(
      "Use benchmark-coordinator.ts --config <trusted-local-configuration.mjs>. VM execution and scores require the real benchmark infrastructure.",
    );
  const module = await import(pathToFileURL(resolve(process.argv[3])).href);
  if (typeof module.configuration !== "object" || !module.configuration)
    throw new Error("Trusted local configuration must export configuration");
  await serveBenchmarkCoordinator(module.configuration);
}
