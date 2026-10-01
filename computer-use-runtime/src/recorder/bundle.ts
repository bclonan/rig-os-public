import { randomUUID } from "node:crypto";
import { hash, canonical, type Store } from "../storage/index.js";
import {
  validate,
  TaskContractSchema,
  ObservationSchema,
  ActionSchema,
  ReceiptSchema,
} from "../contracts/index.js";
import { Recorder, type Demonstration } from "./index.js";
export type DatasetBundle = {
  schemaVersion: 1;
  kind: "experience-bundle";
  demonstrations: Demonstration[];
  artifacts: Record<string, string>;
  digest: string;
  privacy?: {
    mode: "redacted" | "unredacted";
    originalImageHashes: string[];
    originalDemonstrationHashes: string[];
  };
};
export function exportDataset(
  store: Store,
  options: { unredacted?: boolean } = {},
): DatasetBundle {
  const originals = new Recorder(store).export().demonstrations;
  let demonstrations = structuredClone(originals);
  const references = [
    ...new Set(
      demonstrations.flatMap((d) =>
        d.steps.flatMap((s) => [s.before.image!, s.after.image!]),
      ),
    ),
  ];
  const artifacts: Record<string, string> = {};
  if (options.unredacted) {
    for (const id of references)
      artifacts[id] = store.artifactRead(id).toString("base64");
  } else {
    // Imported or recorded top-level metadata has no schema. Project the
    // documented fields rather than exporting arbitrary event payloads.
    const project = (schema: any, value: any): any => {
      if (schema.type === "array" && Array.isArray(value))
        return value.map((item) => project(schema.items, item));
      if (schema.properties && value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(schema.properties)
            .filter(([key]) => Object.hasOwn(value, key))
            .map(([key, child]) => [key, project(child, value[key])]),
        );
      return structuredClone(value);
    };
    demonstrations = demonstrations.map((d) => ({
      id: d.id,
      session: d.session,
      contract: project(TaskContractSchema, d.contract),
      steps: d.steps.map((s) => ({
        before: project(ObservationSchema, s.before),
        after: project(ObservationSchema, s.after),
        action: project(ActionSchema, s.action),
        receipt: project(ReceiptSchema, s.receipt),
        ...(s.guard ? { guard: s.guard } : {}),
        ...(s.verify ? { verify: s.verify } : {}),
        label: s.label,
      })),
      verified: false,
      corrections: [],
    }));
    // A fixed blank PNG preserves bundle shape without exporting source screenshots.
    const placeholder = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
      "base64",
    );
    const placeholderHash = hash(placeholder);
    if (demonstrations.length)
      artifacts[placeholderHash] = placeholder.toString("base64");
    const salt = randomUUID();
    const generatedAliases = new Set<string>();
    const alias = (kind: string, value: string) => {
      if (generatedAliases.has(kind + ":" + value)) return value;
      const result =
        kind + "." + hash(salt + ":" + kind + ":" + value).slice(0, 24);
      generatedAliases.add(kind + ":" + result);
      return result;
    };
    const hide = (
      dict: Record<string, string | number | boolean>,
      all = false,
    ) => {
      for (const key of Object.keys(dict)) {
        const value = dict[key];
        delete dict[key];
        dict[alias("field", key)] =
          all || typeof value !== "boolean" ? "[REDACTED]" : value;
      }
    };
    for (const d of demonstrations) {
      d.id = alias("demonstration", d.id);
      d.session = alias("run", d.session);
      d.contract.id = alias("run", d.contract.id);
      d.contract.correlationId = alias("correlation", d.contract.correlationId);
      if (d.contract.method)
        d.contract.method = alias("method", d.contract.method);
      d.contract.target.host = alias("host", d.contract.target.host);
      d.contract.target.session = alias("session", d.contract.target.session);
      d.contract.target.identity = alias("target", d.contract.target.identity);
      d.verified = false;
      d.contract.goal = "[REDACTED]";
      d.contract.requester = "[REDACTED]";
      d.contract.effects = d.contract.effects.map((effect) =>
        alias("effect", effect),
      );
      hide(d.contract.parameters, true);
      hide(d.contract.expected, true);
      d.contract.requirements.forEach((r) => {
        r.name = "[REDACTED]";
        r.value = "[REDACTED]";
      });
      d.contract.unresolved = d.contract.unresolved.map(() => "[REDACTED]");
      d.corrections = [
        { step: 0, label: "redacted-unverified", source: "privacy-export-v1" },
      ];
      for (const s of d.steps) {
        if (s.guard) s.guard = alias("field", s.guard);
        if (s.verify) s.verify = alias("field", s.verify);
        s.action.scope = alias("effect", s.action.scope);
        s.action.revision = alias("revision", s.action.revision);
        const operations = new Set([
          "fill",
          "click",
          "invoke",
          "select",
          "key",
          "scroll",
          "drag",
          "hold",
          "wait",
          "observe",
          "subskill",
          "focus",
          "type",
          "research_read",
          "workspace_read",
          "workspace_write",
          "construct_artifact",
          "repair_artifact",
        ]);
        if (!operations.has(s.action.operation))
          s.action.operation = "[REDACTED]";
        s.receipt.backend = alias("backend", s.receipt.backend);
        s.receipt.timings = Object.fromEntries(
          Object.entries(s.receipt.timings).map(([key, value]) => [
            alias("timing", key),
            value,
          ]),
        );
        s.action.id = alias("action", s.action.id);
        s.action.runId = alias("run", s.action.runId);
        s.action.observationId = alias("observation", s.action.observationId);
        s.action.host = alias("host", s.action.host);
        s.action.session = alias("session", s.action.session);
        s.action.target = alias("target", s.action.target);
        s.receipt.actionId = alias("action", s.receipt.actionId);
        s.receipt.runId = alias("run", s.receipt.runId);
        s.label = "unknown";
        s.action.requester = "[REDACTED]";
        hide(s.action.args, true);
        s.receipt.detail = "[REDACTED]";
        for (const o of [s.before, s.after]) {
          o.id = alias("observation", o.id);
          o.host = alias("host", o.host);
          o.session = alias("session", o.session);
          o.target = alias("target", o.target);
          o.backend = alias("backend", o.backend);
          o.revision = alias("revision", o.revision);
          o.image = placeholderHash;
          hide(o.facts);
          o.features = [];
          o.controls?.forEach((c) => {
            c.name = "";
            c.value = "";
            c.selection = "";
            c.id = "";
            if (c.actions) c.actions = c.actions.map(() => "[REDACTED]");
          });
          o.desktop?.windows.forEach((w) => {
            w.id = alias("window", w.id);
            w.title = "[REDACTED]";
            w.executable = "[REDACTED]";
          });
          if (o.desktop?.activeWindow)
            o.desktop.activeWindow = alias("window", o.desktop.activeWindow);
          if (
            o.desktop &&
            !["Windows", "macOS", "Linux", "win32", "darwin", "linux"].includes(
              o.desktop.platform,
            )
          )
            o.desktop.platform = "[REDACTED]";
          o.desktop?.apps.forEach((app) => {
            app.id = alias("app", app.id);
            app.name = "[REDACTED]";
          });
        }
      }
    }
  }
  const body = {
    schemaVersion: 1 as const,
    kind: "experience-bundle" as const,
    demonstrations,
    artifacts,
    privacy: {
      mode: options.unredacted
        ? ("unredacted" as const)
        : ("redacted" as const),
      originalImageHashes: references,
      originalDemonstrationHashes: originals.map((d) => hash(canonical(d))),
    },
  };
  return { ...body, digest: hash(canonical(body)) };
}
export function importDataset(store: Store, value: unknown) {
  const b = value as DatasetBundle;
  if (
    !b ||
    b.schemaVersion !== 1 ||
    b.kind !== "experience-bundle" ||
    !Array.isArray(b.demonstrations) ||
    !b.artifacts ||
    typeof b.artifacts !== "object"
  )
    throw new Error("Unsupported dataset schema; no implicit migration");
  if (
    b.demonstrations.length > 1000 ||
    Buffer.byteLength(JSON.stringify(b)) > 32 * 1024 * 1024
  )
    throw new Error("Dataset import budget");
  const { digest, ...body } = b;
  if (hash(canonical(body)) !== digest)
    throw new Error("Dataset digest mismatch");
  const decoded = new Map<string, Buffer>();
  for (const [id, encoded] of Object.entries(b.artifacts)) {
    if (typeof encoded !== "string" || !/^[a-f0-9]{64}$/.test(id))
      throw new Error("Invalid artifact entry");
    const bytes = Buffer.from(encoded, "base64");
    if (hash(bytes) !== id) throw new Error("Artifact hash mismatch");
    decoded.set(id, bytes);
  }
  for (const d of b.demonstrations) {
    validate("TaskContract", d.contract);
    if (!Array.isArray(d.steps) || d.steps.length > 1000)
      throw new Error("Invalid demonstration steps");
    for (const s of d.steps) {
      validate("Observation", s.before);
      validate("Observation", s.after);
      validate("Action", s.action);
      validate("Receipt", s.receipt);
      if (!decoded.has(s.before.image!) || !decoded.has(s.after.image!))
        throw new Error("Missing visual evidence");
      if (s.action.runId !== d.session || s.receipt.actionId !== s.action.id)
        throw new Error("Unbound imported receipt");
    }
  }
  for (const bytes of decoded.values()) store.artifact(bytes);
  const ids = [];
  for (const d of b.demonstrations) {
    const copy = structuredClone(d);
    copy.id = randomUUID();
    copy.verified = false;
    copy.steps.forEach((s) => (s.label = "unknown"));
    copy.corrections = [
      { step: 0, label: "imported-unverified", source: digest },
    ];
    store.put("demonstrations", copy.id, copy);
    ids.push(copy.id);
  }
  return {
    imported: ids.length,
    ids,
    status: "quarantined",
    sourceDigest: digest,
  };
}
