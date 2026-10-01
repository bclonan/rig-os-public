import type {
  Action,
  Observation,
  PredicateEvidence,
  ProviderCapabilities,
  Receipt,
  RunEvent,
  SkillCapsule,
  TaskContract,
} from "./index.js";
import type { Run } from "./run.js";
export interface EnvironmentAdapter {
  readonly host: string;
  readonly session: string;
  readonly identity: string;
  readonly capabilities: string[];
  prepare?(task: TaskContract): Promise<void>;
  focus?(): Promise<void>;
  observe(signal?: AbortSignal): Promise<Observation>;
  acquire(runId: string): Promise<number>;
  execute(action: Action, signal?: AbortSignal): Promise<Receipt>;
  release(runId: string): Promise<void>;
  takeover(): Promise<void>;
  /** Trusted scopes whose cleanup is acknowledged by a successful returnControl. */
  cleanupScopes?(): ReadonlyArray<{ host: string; session: string }>;
  returnControl(): Promise<void>;
  close(): Promise<void>;
}
export interface ModelProvider {
  capabilities: ProviderCapabilities;
  generate(
    prompt: string,
    schema: object,
    signal?: AbortSignal,
    images?: string[],
    think?: boolean,
  ): Promise<unknown>;
}
export interface EvidenceVerifier {
  verify(task: TaskContract, observation: Observation): PredicateEvidence[];
}
export interface SkillRepository {
  get(id: string): SkillCapsule;
  list(): SkillCapsule[];
  put(skill: SkillCapsule): void;
  version(hash: string): SkillCapsule;
}
export interface ArtifactStore {
  artifact(bytes: Buffer | string): string;
  artifactRead(hash: string): Buffer;
}
/** Durable journals and synchronous commit/rollback for one coordinator.
 * Returned runs, events and values are detached snapshots.
 */
export interface ExperienceStore extends ArtifactStore {
  transaction<T>(operation: () => T): T;
  putRun(run: Run): void;
  run(id: string): Run;
  runs(): Run[];
  append(
    runId: string,
    type: string,
    data: unknown,
    correlationId: string,
  ): RunEvent;
  events(after?: number, runId?: string): RunEvent[];
  put(namespace: string, key: string, value: unknown): void;
  get<T>(namespace: string, key: string): T | undefined;
  list<T>(namespace: string): T[];
  dedup(key: string, body: unknown): string | undefined;
  remember(key: string, body: unknown, runId: string): void;
  close(): void;
}
export interface PermissionPolicy {
  authorize(task: TaskContract, action: Action, observation: Observation): void;
}
