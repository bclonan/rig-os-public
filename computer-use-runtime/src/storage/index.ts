import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import type { RunEvent } from "../contracts/index.js";
import type { ExperienceStore } from "../contracts/ports.js";
import type { Run } from "../contracts/run.js";
import { canonical, hash } from "../util/canonical.js";
export { canonical, hash } from "../util/canonical.js";
export type { Run } from "../contracts/run.js";
export class StoreLockedError extends Error {
  constructor(
    readonly root: string,
    readonly pid: number,
  ) {
    super(`Another coordinator owns this store: ${root} (process ${pid})`);
    this.name = "StoreLockedError";
  }
}
export class Store implements ExperienceStore {
  db: DatabaseSync;
  root: string;
  private lock: string;
  private owner = randomBytes(24).toString("hex");
  private closed = false;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(join(this.root, "artifacts"), { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      chmodSync(this.root, 0o700);
      chmodSync(join(this.root, "artifacts"), 0o700);
    }
    this.lock = join(this.root, "coordinator.lock");
    // Keep the PID file compatible with older coordinators. SQLite serializes
    // new claims, including simultaneous recovery of the same stale PID file.
    if (existsSync(this.lock)) {
      const pid = Number(readFileSync(this.lock, "utf8"));
      if (this.alive(pid)) throw new StoreLockedError(this.root, pid);
    }
    let database: DatabaseSync | undefined;
    let claimed = false;
    try {
      this.db = database = new DatabaseSync(join(this.root, "runtime.sqlite"));
      this.db.exec("PRAGMA busy_timeout=250");
      // Switching a newly created database to WAL may return SQLITE_BUSY without
      // invoking SQLite's busy handler. Retry only this idempotent setup, never a
      // transaction whose commit or input delivery could be uncertain.
      const setupDeadline = Date.now() + 3000;
      for (;;) {
        try {
          this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS coordinator(singleton INTEGER PRIMARY KEY CHECK(singleton=1),pid INTEGER,owner TEXT);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT,correlation TEXT,at REAL,type TEXT,data TEXT);
      CREATE TABLE IF NOT EXISTS kv(namespace TEXT,key TEXT,body TEXT,PRIMARY KEY(namespace,key));
      CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY,digest TEXT,run_id TEXT);
      CREATE TABLE IF NOT EXISTS leases(session TEXT PRIMARY KEY,run_id TEXT,generation INTEGER,manual INTEGER DEFAULT 0,expires REAL);`);
          break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("errcode" in error) ||
            (Number(error.errcode) & 255) !== 5 ||
            Date.now() >= setupDeadline
          )
            throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
      }
      this.db.exec("PRAGMA busy_timeout=3000");
      this.transaction(() => {
        const previous = this.db
          .prepare("SELECT pid FROM coordinator WHERE singleton=1")
          .get() as { pid: number } | undefined;
        if (previous && this.alive(previous.pid))
          throw new StoreLockedError(this.root, previous.pid);
        this.db
          .prepare("INSERT OR REPLACE INTO coordinator VALUES(1,?,?)")
          .run(process.pid, this.owner);
      });
      claimed = true;
      writeFileSync(this.lock, String(process.pid), { mode: 0o600 });
    } catch (error) {
      if (claimed)
        database
          ?.prepare("DELETE FROM coordinator WHERE owner=?")
          .run(this.owner);
      database?.close();
      throw error;
    }
  }
  private alive(pid: number) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: any) {
      return error.code !== "ESRCH";
    }
  }
  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      if (result && typeof (result as any).then === "function")
        throw new Error("Asynchronous transaction callbacks are forbidden");
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  putRun(run: Run) {
    this.db
      .prepare("INSERT OR REPLACE INTO runs VALUES(?,?)")
      .run(run.id, JSON.stringify(run));
  }
  run(id: string): Run {
    const row = this.db
      .prepare("SELECT body FROM runs WHERE id=?")
      .get(id) as any;
    if (!row) throw new Error("Run not found");
    return JSON.parse(row.body);
  }
  runs(): Run[] {
    return (this.db.prepare("SELECT body FROM runs").all() as any[]).map((r) =>
      JSON.parse(r.body),
    );
  }
  append(
    runId: string,
    type: string,
    data: unknown,
    correlationId: string,
  ): RunEvent {
    const at = Date.now();
    const r = this.db
      .prepare(
        "INSERT INTO events(run_id,correlation,at,type,data) VALUES(?,?,?,?,?)",
      )
      .run(runId, correlationId, at, type, JSON.stringify(data));
    return {
      schemaVersion: 1,
      seq: Number(r.lastInsertRowid),
      runId,
      correlationId,
      at,
      type,
      data,
    };
  }
  events(after = 0, runId?: string): RunEvent[] {
    const q = runId
      ? "SELECT * FROM events WHERE seq>? AND run_id=? ORDER BY seq"
      : "SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 5000";
    return (
      this.db.prepare(q).all(...(runId ? [after, runId] : [after])) as any[]
    ).map((r) => ({
      schemaVersion: 1,
      seq: r.seq,
      runId: r.run_id,
      correlationId: r.correlation,
      at: r.at,
      type: r.type,
      data: JSON.parse(r.data),
    }));
  }
  put(ns: string, key: string, v: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO kv VALUES(?,?,?)")
      .run(ns, key, JSON.stringify(v));
  }
  get<T>(ns: string, key: string): T | undefined {
    const r = this.db
      .prepare("SELECT body FROM kv WHERE namespace=? AND key=?")
      .get(ns, key) as any;
    return r ? JSON.parse(r.body) : undefined;
  }
  list<T>(ns: string): T[] {
    return (
      this.db.prepare("SELECT body FROM kv WHERE namespace=?").all(ns) as any[]
    ).map((r) => JSON.parse(r.body));
  }
  dedup(key: string, body: unknown): string | undefined {
    const row = this.db
      .prepare("SELECT * FROM requests WHERE key=?")
      .get(key) as any;
    if (row && row.digest !== hash(canonical(body)))
      throw new Error("Idempotency key reused with different request");
    return row?.run_id;
  }
  remember(key: string, body: unknown, runId: string) {
    this.db
      .prepare("INSERT INTO requests VALUES(?,?,?)")
      .run(key, hash(canonical(body)), runId);
  }
  artifact(bytes: Buffer | string): string {
    const id = hash(bytes);
    const path = join(this.root, "artifacts", id);
    try {
      writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (hash(readFileSync(path)) !== id)
        throw new Error("Corrupt existing artifact; ingestion refused");
    }
    return id;
  }
  artifactRead(id: string): Buffer {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid artifact hash");
    const bytes = readFileSync(join(this.root, "artifacts", id));
    if (hash(bytes) !== id) throw new Error("Corrupt artifact");
    return bytes;
  }
  token(): string {
    let token = this.get<string>("secret", "service");
    if (!token) {
      token = randomBytes(32).toString("hex");
      this.put("secret", "service", token);
    }
    return token;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.transaction(() => {
        this.db
          .prepare("DELETE FROM coordinator WHERE owner=?")
          .run(this.owner);
        if (
          existsSync(this.lock) &&
          readFileSync(this.lock, "utf8") === String(process.pid)
        )
          unlinkSync(this.lock);
      });
    } finally {
      this.db.close();
    }
  }
}
