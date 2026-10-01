import { isUtf8 } from "node:buffer";
import { readFileSync } from "node:fs";
import type { SkillCapsule } from "../contracts/index.js";
import type { ExperienceStore, SkillRepository } from "../contracts/ports.js";
import { canonical, hash } from "../util/canonical.js";
import { checkSkill, seal } from "./index.js";

const sourceLimit = 1024 * 1024;
const bundleLimit = 4 * sourceLimit;
const closureLimit = 64;
const migrationId = "raw-skill-v1-to-bundle-v2";
type Binding = { id: string; hash: string };
export interface SkillBundleV2 {
  kind: "skill-bundle";
  schemaVersion: 2;
  capsule: SkillCapsule;
  root: Binding;
  dependencies: Binding[];
  origin: {
    kind: "raw-skill-capsule";
    schemaVersion: 1;
    sha256: string;
    originalBase64: string;
  };
  migration: {
    id: typeof migrationId;
    from: 1;
    to: 2;
    implementationSha256: string;
  };
  digest: string;
}
type MigrationRoute = { from: 1; to: 2 };

function object(
  value: unknown,
  keys: string[],
): asserts value is Record<string, any> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    canonical(Object.keys(value).sort()) !== canonical([...keys].sort())
  )
    throw new Error("Unsupported skill bundle fields or types");
}
function digest(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid skill bundle digest");
}
function parse(source: Buffer, maximum: number): any {
  if (
    !Buffer.isBuffer(source) ||
    !source.length ||
    source.length > maximum ||
    !isUtf8(source)
  )
    throw new Error("Skill bundle byte budget or UTF8 encoding");
  return JSON.parse(source.toString("utf8"));
}
function implementation() {
  return hash(readFileSync(new URL(import.meta.url)));
}
function route(value: unknown): asserts value is MigrationRoute {
  object(value, ["from", "to"]);
  if (value.from !== 1 || value.to !== 2)
    throw new Error("Unsupported skill migration version or transform");
}
function binding(value: unknown): asserts value is Binding {
  object(value, ["id", "hash"]);
  if (typeof value.id !== "string" || !value.id.length)
    throw new Error("Invalid dependency ID");
  digest(value.hash);
}

/** Resolve the complete declared dependency graph, including unused declarations. */
export function skillDependencyManifest(
  root: SkillCapsule,
  repository: SkillRepository,
): Binding[] {
  checkSkill(root);
  const found = new Map<string, string>();
  function visit(skill: SkillCapsule, stack: string[]) {
    if (new Set(skill.dependencies).size !== skill.dependencies.length)
      throw new Error("Duplicate skill dependency");
    for (const id of skill.dependencies) {
      if (stack.includes(id)) throw new Error("Cyclic skill dependency");
      const dependency = checkSkill(repository.get(id));
      if (dependency.id !== id)
        throw new Error("Dependency repository identity mismatch");
      if (found.has(id)) {
        if (found.get(id) !== dependency.hash)
          throw new Error("Dependency changed during resolution");
        continue;
      }
      found.set(id, dependency.hash);
      if (found.size > closureLimit)
        throw new Error("Skill dependency closure budget");
      visit(dependency, [...stack, id]);
    }
  }
  visit(root, [root.id]);
  return [...found]
    .map(([id, hash]) => ({ id, hash }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function previewSkillMigration(
  source: Buffer,
  requested: MigrationRoute,
  repository: SkillRepository,
): SkillBundleV2 {
  route(requested);
  const capsule = structuredClone(checkSkill(parse(source, sourceLimit)));
  const dependencies = skillDependencyManifest(capsule, repository);
  const body: Omit<SkillBundleV2, "digest"> = {
    kind: "skill-bundle" as const,
    schemaVersion: 2 as const,
    capsule,
    root: { id: capsule.id, hash: capsule.hash },
    dependencies,
    origin: {
      kind: "raw-skill-capsule" as const,
      schemaVersion: 1 as const,
      sha256: hash(source),
      originalBase64: source.toString("base64"),
    },
    migration: {
      id: migrationId,
      from: 1 as const,
      to: 2 as const,
      implementationSha256: implementation(),
    },
  };
  const bundle = { ...body, digest: hash(canonical(body)) };
  if (Buffer.byteLength(canonical(bundle)) > bundleLimit)
    throw new Error("Skill bundle byte budget");
  return bundle;
}

/** Foreign transform hashes describe provenance. Only this handwritten route validates semantics. */
export function validateSkillBundle(
  source: Buffer,
  repository: SkillRepository,
): SkillBundleV2 {
  const value = parse(source, bundleLimit);
  object(value, [
    "kind",
    "schemaVersion",
    "capsule",
    "root",
    "dependencies",
    "origin",
    "migration",
    "digest",
  ]);
  if (value.kind !== "skill-bundle" || value.schemaVersion !== 2)
    throw new Error("Unsupported skill bundle schema version");
  digest(value.digest);
  object(value.origin, ["kind", "schemaVersion", "sha256", "originalBase64"]);
  object(value.migration, ["id", "from", "to", "implementationSha256"]);
  if (
    value.origin.kind !== "raw-skill-capsule" ||
    value.origin.schemaVersion !== 1 ||
    value.migration.id !== migrationId
  )
    throw new Error("Unsupported skill migration version or transform");
  route({ from: value.migration.from, to: value.migration.to });
  digest(value.migration.implementationSha256);
  digest(value.origin.sha256);
  const encoded = value.origin.originalBase64;
  if (
    typeof encoded !== "string" ||
    encoded.length > Math.ceil(sourceLimit / 3) * 4
  )
    throw new Error("Original skill byte budget");
  const original = Buffer.from(encoded, "base64");
  if (
    original.toString("base64") !== encoded ||
    hash(original) !== value.origin.sha256
  )
    throw new Error("Original skill bytes or digest mismatch");
  const capsule = checkSkill(value.capsule);
  binding(value.root);
  if (value.root.id !== capsule.id || value.root.hash !== capsule.hash)
    throw new Error("Root skill binding mismatch");
  if (
    !Array.isArray(value.dependencies) ||
    value.dependencies.length > closureLimit
  )
    throw new Error("Skill dependency manifest budget");
  value.dependencies.forEach(binding);
  const recomputed = previewSkillMigration(
    original,
    { from: 1, to: 2 },
    repository,
  );
  if (
    canonical(capsule) !== canonical(recomputed.capsule) ||
    canonical(value.dependencies) !== canonical(recomputed.dependencies)
  )
    throw new Error("Migrated capsule or dependency closure changed");
  const { digest: expected, ...body } = value;
  if (hash(canonical(body)) !== expected)
    throw new Error("Skill bundle body digest mismatch");
  return structuredClone(value) as SkillBundleV2;
}

function immutableRecord(
  store: ExperienceStore,
  namespace: string,
  key: string,
  body: Record<string, unknown>,
) {
  const bytes = canonical(body),
    artifact = hash(bytes);
  const prior = store.get<any>(namespace, key);
  if (prior) {
    if (
      prior.artifact !== artifact ||
      store.artifactRead(artifact).toString() !== bytes
    )
      throw new Error("Immutable skill migration receipt changed");
    return prior;
  }
  store.artifact(bytes);
  const receipt = { ...body, artifact };
  store.put(namespace, key, receipt);
  return receipt;
}
export function commitSkillMigration(
  store: ExperienceStore,
  source: Buffer,
  requested: MigrationRoute,
  repository: SkillRepository,
) {
  const bundle = previewSkillMigration(source, requested, repository);
  const existing = store.get<any>("skill-migrations", bundle.digest);
  if (existing) {
    const { artifact, ...body } = existing;
    if (
      hash(canonical(body)) !== artifact ||
      store.artifactRead(artifact).toString() !== canonical(body) ||
      store.artifactRead(existing.sourceArtifact).compare(source) !== 0 ||
      store.artifactRead(existing.bundleArtifact).toString() !==
        canonical(bundle)
    )
      throw new Error("Immutable skill migration receipt changed");
    return { bundle, receipt: existing };
  }
  return store.transaction(() => {
    const sourceArtifact = store.artifact(source),
      bundleArtifact = store.artifact(canonical(bundle));
    const receipt = immutableRecord(store, "skill-migrations", bundle.digest, {
      schemaVersion: 1,
      kind: "trusted-skill-migration",
      route: requested,
      sourceArtifact,
      bundleArtifact,
      targetDigest: bundle.digest,
      root: bundle.root,
      dependencies: bundle.dependencies,
      implementationSha256: implementation(),
      at: Date.now(),
    });
    return { bundle, receipt };
  });
}
export function exportSkillBundle(id: string, repository: SkillRepository) {
  return previewSkillMigration(
    Buffer.from(canonical(repository.get(id))),
    { from: 1, to: 2 },
    repository,
  );
}

function candidateFrom(source: SkillCapsule) {
  return seal({
    ...source,
    status: "quarantined",
    provenance: {
      kind: source.provenance.kind,
      demonstrations: [],
      tests: [],
      uncertain: [...source.provenance.uncertain],
    },
  });
}
function install(
  store: ExperienceStore,
  repository: SkillRepository,
  source: SkillCapsule,
  dependencies: Binding[],
  original: Buffer,
  bundle?: { value: SkillBundleV2; bytes: Buffer },
) {
  if (repository.list().some((skill) => skill.id === source.id))
    throw new Error(
      "Skill ID already exists. Import under a new ID with a valid hash.",
    );
  const candidate = candidateFrom({
    ...source,
    version:
      source.version +
      (source.version.includes("+") ? "." : "+") +
      "import." +
      source.hash.slice(0, 16),
  });
  return store.transaction(() => {
    const sourceArtifact = store.artifact(original);
    const bundleArtifact = bundle ? store.artifact(bundle.bytes) : undefined;
    const body = {
      schemaVersion: 1,
      kind: "quarantined-skill-import",
      id: candidate.id,
      sourceArtifact,
      sourceHash: source.hash,
      candidateHash: candidate.hash,
      root: { id: source.id, hash: source.hash },
      dependencies,
      ...(bundle
        ? {
            bundleArtifact,
            bundleDigest: bundle.value.digest,
            foreignImplementationSha256:
              bundle.value.migration.implementationSha256,
          }
        : {}),
      implementationSha256: implementation(),
      at: Date.now(),
    };
    const receipt = immutableRecord(
      store,
      "skill-import-receipts",
      candidate.hash,
      body,
    );
    store.put("skill-import-origins", candidate.id, {
      candidateHash: candidate.hash,
      receiptArtifact: receipt.artifact,
    });
    repository.put(candidate);
    return { candidate, receipt };
  });
}
export function importSkillBundle(
  store: ExperienceStore,
  repository: SkillRepository,
  source: Buffer,
) {
  const bundle = validateSkillBundle(source, repository);
  const original = Buffer.from(bundle.origin.originalBase64, "base64");
  return install(
    store,
    repository,
    bundle.capsule,
    bundle.dependencies,
    original,
    { value: bundle, bytes: source },
  );
}
export function importLegacySkill(
  store: ExperienceStore,
  repository: SkillRepository,
  value: unknown,
) {
  const source = checkSkill(value),
    bytes = Buffer.from(canonical(source));
  if (bytes.length > sourceLimit) throw new Error("Skill bundle byte budget");
  return install(
    store,
    repository,
    source,
    skillDependencyManifest(source, repository),
    bytes,
  ).candidate;
}

export function skillMigrationRequest(value: unknown) {
  object(value, ["source", "from", "to"]);
  if (typeof value.source !== "string")
    throw new Error("Migration source must contain exact UTF8 JSON text");
  const requested = { from: value.from, to: value.to };
  route(requested);
  return { source: Buffer.from(value.source), route: requested };
}
export function skillBundleImportRequest(value: unknown) {
  object(value, ["source"]);
  if (typeof value.source !== "string")
    throw new Error("Import source must contain exact UTF8 JSON text");
  return Buffer.from(value.source);
}

/** Imported test evidence never survives a dependency change. */
export function checkImportedSkillPublication(
  store: ExperienceStore,
  repository: SkillRepository,
  skill: SkillCapsule,
  tests: string[],
) {
  const origin = store.get<any>("skill-import-origins", skill.id);
  if (!origin) {
    if (skill.status === "quarantined")
      throw new Error(
        "Imported skill origin is missing; repeat explicit import review",
      );
    return;
  }
  const bytes = store.artifactRead(origin.receiptArtifact);
  if (hash(bytes) !== origin.receiptArtifact)
    throw new Error("Imported skill receipt bytes changed");
  const receipt = JSON.parse(bytes.toString());
  if (
    receipt.kind !== "quarantined-skill-import" ||
    receipt.id !== skill.id ||
    receipt.candidateHash !== origin.candidateHash ||
    candidateFrom(skill).hash !== origin.candidateHash
  )
    throw new Error(
      "Imported skill candidate changed; use a new explicit import and tests",
    );
  if (
    hash(store.artifactRead(receipt.sourceArtifact)) !== receipt.sourceArtifact
  )
    throw new Error("Imported original bytes changed");
  const manifest = skillDependencyManifest(skill, repository);
  if (canonical(manifest) !== canonical(receipt.dependencies))
    throw new Error(
      "Imported dependency closure changed; use a new explicit import and tests",
    );
  if (receipt.bundleArtifact) {
    const source = store.artifactRead(receipt.bundleArtifact);
    if (
      hash(source) !== receipt.bundleArtifact ||
      validateSkillBundle(source, repository).digest !== receipt.bundleDigest
    )
      throw new Error("Imported skill bundle changed");
  }
  for (const id of tests) {
    const versions = store.run(id).bindings.skillVersions as
      Record<string, string> | undefined;
    if (
      !versions ||
      versions[skill.id] !== skill.hash ||
      Object.entries(versions).some(
        ([id, value]) =>
          id !== skill.id &&
          !manifest.some(
            (binding) => binding.id === id && binding.hash === value,
          ),
      )
    )
      throw new Error(
        "Imported publication tests used another dependency closure",
      );
  }
}
