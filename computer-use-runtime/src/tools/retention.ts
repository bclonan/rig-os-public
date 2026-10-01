import { randomUUID } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import { canonical, hash, type Store } from "../storage/index.js";
export type RetentionPlan = {
  schemaVersion: 1;
  id: string;
  rootHash: string;
  createdAt: number;
  olderThan: number;
  referencesHash: string;
  delete: { artifact: string; bytes: number; mtimeMs: number }[];
  preservedReferences: number;
  policy: "unreferenced-artifacts-only";
  digest: string;
};
function artifactDirectory(store: Store) {
  const root = realpathSync(store.root),
    path = join(root, "artifacts");
  if (lstatSync(path).isSymbolicLink())
    throw new Error("Artifact directory symlink rejected");
  const resolved = realpathSync(path),
    part = relative(root, resolved);
  if (isAbsolute(part) || part === ".." || part.startsWith(".." + sep))
    throw new Error("Artifact directory escapes store");
  return resolved;
}
function references(store: Store) {
  const ids = new Set<string>();
  const scan = (value: unknown) => {
    if (typeof value === "string") {
      if (/^[a-f0-9]{64}$/.test(value)) ids.add(value);
      // Event strings may embed JSON or references. Conservatively retain every hash.
      for (const match of value.matchAll(/\b[a-f0-9]{64}\b/g))
        ids.add(match[0]);
    } else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === "object")
      Object.entries(value).forEach(([key, entry]) => {
        scan(key);
        scan(entry);
      });
  };
  for (const row of store.db.prepare("SELECT body FROM runs").all())
    scan(JSON.parse(String(row.body)));
  for (const row of store.db.prepare("SELECT data FROM events").all())
    scan(JSON.parse(String(row.data)));
  // A retention preview must not count its own orphan-delete entries as live references.
  for (const row of store.db
    .prepare(
      "SELECT body FROM kv WHERE namespace NOT IN ('retention-plans','retention-results','retention-intents')",
    )
    .all())
    scan(JSON.parse(String(row.body)));
  return [...ids].sort();
}
export function previewRetention(
  store: Store,
  olderThan: number,
): RetentionPlan {
  if (!Number.isFinite(olderThan) || olderThan > Date.now() - 86400000)
    throw new Error(
      "Retention requires an explicit cutoff at least one day old",
    );
  const directory = artifactDirectory(store),
    retained = references(store),
    protectedIds = new Set(retained);
  const candidates: RetentionPlan["delete"] = [];
  for (const id of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}$/.test(id) || protectedIds.has(id)) continue;
    const path = join(directory, id),
      stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.mtimeMs >= olderThan
    )
      continue;
    if (hash(readFileSync(path)) !== id) continue;
    candidates.push({ artifact: id, bytes: stat.size, mtimeMs: stat.mtimeMs });
  }
  const body = {
    schemaVersion: 1 as const,
    id: randomUUID(),
    rootHash: hash(store.root),
    createdAt: Date.now(),
    olderThan,
    referencesHash: hash(canonical(retained)),
    delete: candidates.sort((a, b) => a.artifact.localeCompare(b.artifact)),
    preservedReferences: retained.length,
    policy: "unreferenced-artifacts-only" as const,
  };
  const plan = { ...body, digest: hash(canonical(body)) };
  store.put("retention-plans", plan.id, plan);
  return plan;
}
export function applyRetention(
  store: Store,
  plan: RetentionPlan,
  confirmation: string,
) {
  if (confirmation !== plan.digest)
    throw new Error(
      "Retention requires confirmation of the exact preview digest",
    );
  const saved = store.get<RetentionPlan>("retention-plans", plan.id);
  if (
    !saved ||
    canonical(saved) !== canonical(plan) ||
    plan.rootHash !== hash(store.root)
  )
    throw new Error("Retention preview is not bound to this store");
  const { digest, ...body } = plan;
  if (hash(canonical(body)) !== digest)
    throw new Error("Retention preview changed");
  const prior = store.get<{ removed: string[] }>("retention-results", plan.id);
  if (prior) return prior;
  type Intent = {
    digest: string;
    approvedAt: number;
    removed: string[];
    pending?: string;
  };
  let intent = store.get<Intent>("retention-intents", plan.id);
  if (intent && intent.digest !== digest)
    throw new Error("Confirmed retention intent changed");
  if (!intent && Date.now() - plan.createdAt > 3600000)
    throw new Error("Retention preview expired");
  const directory = artifactDirectory(store);
  const assertReferences = () => {
    if (hash(canonical(references(store))) !== plan.referencesHash)
      throw new Error("Store references changed; preview retention again");
  };
  const validateFile = (entry: RetentionPlan["delete"][number]) => {
    const path = join(directory, entry.artifact),
      stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size !== entry.bytes ||
      stat.mtimeMs !== entry.mtimeMs ||
      hash(readFileSync(path)) !== entry.artifact
    )
      throw new Error("Retention artifact changed; preview again");
  };
  assertReferences();
  if (!intent) {
    // Confirm and validate all files before the first irreversible deletion.
    plan.delete.forEach(validateFile);
    intent = { digest, approvedAt: Date.now(), removed: [] };
    store.put("retention-intents", plan.id, intent);
  }
  for (const entry of plan.delete) {
    const path = join(directory, entry.artifact);
    if (intent.removed.includes(entry.artifact)) continue;
    assertReferences();
    try {
      validateFile(entry);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        intent.pending !== entry.artifact
      )
        throw error;
      // Only a previously confirmed, journaled unlink can settle an absent file.
      intent.removed.push(entry.artifact);
      delete intent.pending;
      store.put("retention-intents", plan.id, intent);
      continue;
    }
    intent.pending = entry.artifact;
    store.put("retention-intents", plan.id, intent);
    unlinkSync(path);
    intent.removed.push(entry.artifact);
    delete intent.pending;
    store.put("retention-intents", plan.id, intent);
  }
  const result = { removed: [...intent.removed] };
  store.put("retention-results", plan.id, result);
  return result;
}
