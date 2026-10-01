import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { RunEvent } from "../../src/contracts/index.js";
import type { ExperienceStore } from "../../src/contracts/ports.js";
import type { Run } from "../../src/contracts/run.js";
import { canonical, hash } from "../../src/util/canonical.js";

type State = {
  schemaVersion: 1;
  runs: Record<string, Run>;
  events: RunEvent[];
  values: Record<string, unknown>;
  requests: Record<string, { digest: string; runId: string }>;
};
const detach = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const own = <T>(values: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(values, key) ? values[key] : undefined;
export function durableJson(path: string, value: unknown) {
  const temporary = path + "." + randomUUID() + ".pending";
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, JSON.stringify(value));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

/** Independent JSON example for one trusted coordinator. No SQL or Store delegation.
 * A stale ownership file fails closed and needs explicit operator recovery.
 * This example does not claim filesystem power-loss guarantees beyond file fsync.
 */
export class JsonExperienceStore implements ExperienceStore {
  readonly root: string;
  private readonly path: string;
  private readonly lock: string;
  private readonly owner = randomUUID();
  private state: State;
  private depth = 0;
  private closed = false;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    mkdirSync(join(this.root, "artifacts"), { recursive: true });
    this.path = join(this.root, "experience.json");
    this.lock = join(this.root, "coordinator.json");
    if (existsSync(this.lock))
      throw new Error(
        "Another JSON coordinator owns this store or requires explicit recovery",
      );
    const descriptor = openSync(this.lock, "wx", 0o600);
    try {
      writeFileSync(
        descriptor,
        JSON.stringify({ pid: process.pid, owner: this.owner }),
      );
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      this.state = existsSync(this.path)
        ? JSON.parse(readFileSync(this.path, "utf8"))
        : { schemaVersion: 1, runs: {}, events: [], values: {}, requests: {} };
      if (this.state.schemaVersion !== 1 || !Array.isArray(this.state.events))
        throw new Error("Unsupported JSON experience version");
      this.commit();
    } catch (error) {
      unlinkSync(this.lock);
      throw error;
    }
  }
  private open() {
    if (this.closed) throw new Error("JSON experience is closed");
  }
  private commit() {
    this.open();
    if (!this.depth) durableJson(this.path, this.state);
  }
  private mutate<T>(operation: () => T): T {
    this.open();
    if (this.depth) return operation();
    return this.transaction(operation);
  }
  transaction<T>(operation: () => T): T {
    this.open();
    const previous = detach(this.state),
      depthBefore = this.depth;
    this.depth++;
    try {
      const result = operation();
      if (result && typeof (result as any).then === "function")
        throw new Error("Asynchronous transaction callbacks are forbidden");
      this.depth = depthBefore;
      this.commit();
      return result;
    } catch (error) {
      this.state = previous;
      throw error;
    } finally {
      this.depth = depthBefore;
    }
  }
  putRun(run: Run) {
    this.mutate(() => {
      Object.defineProperty(this.state.runs, run.id, {
        value: detach(run),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  }
  run(id: string) {
    this.open();
    const value = own(this.state.runs, id);
    if (!value) throw new Error("Run not found");
    return detach(value);
  }
  runs() {
    this.open();
    return detach(Object.values(this.state.runs));
  }
  append(
    runId: string,
    type: string,
    data: unknown,
    correlationId: string,
  ): RunEvent {
    return this.mutate(() => {
      const event: RunEvent = {
        schemaVersion: 1,
        seq: (this.state.events.at(-1)?.seq || 0) + 1,
        runId,
        type,
        data: detach(data),
        correlationId,
        at: Date.now(),
      };
      this.state.events.push(event);
      return detach(event);
    });
  }
  events(after = 0, runId?: string) {
    this.open();
    return detach(
      this.state.events
        .filter(
          (event) => event.seq > after && (!runId || event.runId === runId),
        )
        .slice(0, runId ? undefined : 5000),
    );
  }
  put(namespace: string, key: string, value: unknown) {
    this.mutate(() => {
      this.state.values[JSON.stringify([namespace, key])] = detach(value);
    });
  }
  get<T>(namespace: string, key: string): T | undefined {
    this.open();
    const value = own(this.state.values, JSON.stringify([namespace, key]));
    return value === undefined ? undefined : (detach(value) as T);
  }
  list<T>(namespace: string): T[] {
    this.open();
    return Object.entries(this.state.values)
      .filter(([key]) => JSON.parse(key)[0] === namespace)
      .map(([, value]) => detach(value) as T);
  }
  dedup(key: string, body: unknown) {
    this.open();
    const previous = own(this.state.requests, key);
    if (previous && previous.digest !== hash(canonical(body)))
      throw new Error("Idempotency key reused with different request");
    return previous?.runId;
  }
  remember(key: string, body: unknown, runId: string) {
    this.mutate(() => {
      if (own(this.state.requests, key))
        throw new Error("Duplicate request record");
      Object.defineProperty(this.state.requests, key, {
        value: { digest: hash(canonical(body)), runId },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    });
  }
  artifact(bytes: Buffer | string) {
    this.open();
    const digest = hash(bytes),
      path = join(this.root, "artifacts", digest);
    if (existsSync(path)) this.artifactRead(digest);
    else {
      const descriptor = openSync(path, "wx", 0o600);
      try {
        writeFileSync(descriptor, bytes);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
    return digest;
  }
  artifactRead(digest: string) {
    this.open();
    if (!/^[a-f0-9]{64}$/.test(digest))
      throw new Error("Invalid artifact hash");
    const bytes = readFileSync(join(this.root, "artifacts", digest));
    if (hash(bytes) !== digest) throw new Error("Corrupt artifact");
    return bytes;
  }
  close() {
    if (this.closed) return;
    const owner = JSON.parse(readFileSync(this.lock, "utf8"));
    if (owner.owner !== this.owner)
      throw new Error("JSON coordinator ownership changed");
    unlinkSync(this.lock);
    this.closed = true;
  }
}
