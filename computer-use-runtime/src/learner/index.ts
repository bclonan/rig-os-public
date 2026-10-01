import * as ort from "onnxruntime-node";
import { verifySealedAudit } from "./audit.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, hash, type Store } from "../storage/index.js";
import type {
  Observation,
  SkillCapsule,
  ModelVersion,
} from "../contracts/index.js";
import {
  verifyFollowupAudit,
  type FollowupQualification,
} from "./qualification.js";
import { visualStateContext } from "./context.js";
export class Controller {
  private constructor(private session: ort.InferenceSession) {}
  static async load(path: string) {
    return new Controller(
      await ort.InferenceSession.create(path, {
        executionProviders: ["cpu"],
        intraOpNumThreads: 2,
      }),
    );
  }
  async rank(
    observation: Observation,
    skills: Pick<SkillCapsule, "descriptor">[],
    context?: Float32Array,
    capturedPixels?: Float32Array,
  ) {
    if (
      !skills.length ||
      skills.length > 1024 ||
      skills.some(
        (s) =>
          s.descriptor.length !== 8 ||
          s.descriptor.some((v) => !Number.isFinite(v)),
      ) ||
      observation.features.some((v) => !Number.isFinite(v))
    )
      throw new Error(
        "Controller requires finite observations and one to 1024 valid skill descriptors",
      );
    // Features are current captured indicator pixels. No post-action fields enter policy input.
    const pixels = capturedPixels
      ? new Float32Array(capturedPixels)
      : new Float32Array(3 * 32 * 32);
    if (
      capturedPixels &&
      (pixels.length !== 3072 ||
        pixels.some((v) => !Number.isFinite(v) || v < 0 || v > 1))
    )
      throw new Error("Invalid captured learning pixels");
    if (!capturedPixels)
      for (let c = 0; c < 3; c++)
        pixels.fill(observation.features[c] || 0, c * 1024, (c + 1) * 1024);
    const history = context ? new Float32Array(context) : new Float32Array(36);
    if (
      ![36, 48].includes(history.length) ||
      Array.from(history).some((x) => !Number.isFinite(x))
    )
      throw new Error("Invalid history context");
    if (!context) {
      history[24] = 1;
      history[32] = 1;
      history[33] = 0.5;
      history[35] = 1;
    }
    if (history.length === 48) history.fill(0, 36, 44);
    if (history.length === 48 && history[47] === -1 && !capturedPixels)
      throw new Error("Visual state inference requires actual captured pixels");
    const candidates = new Float32Array(skills.flatMap((s) => s.descriptor));
    const start = performance.now();
    const feed = {
      image: new ort.Tensor("float32", pixels, [1, 3, 32, 32]),
      history: new ort.Tensor("float32", history, [1, history.length / 12, 12]),
      candidates: new ort.Tensor("float32", candidates, [1, skills.length, 8]),
    };
    const out = await this.session.run(feed);
    const scores = Array.from(out.scores.data as Float32Array);
    if (
      scores.length !== skills.length ||
      scores.some((v) => !Number.isFinite(v))
    )
      throw new Error("Controller returned invalid scores");
    const index = scores.indexOf(Math.max(...scores));
    const auxiliary =
      history.length === 48
        ? await this.session.run({
            ...feed,
            history: new ort.Tensor(
              "float32",
              new Float32Array([
                ...history.slice(0, 36),
                ...skills[index].descriptor,
                ...history.slice(44),
              ]),
              [1, 4, 12],
            ),
          })
        : out;
    const stateHeads =
      history.length === 48 && history[47] === -1
        ? await this.session.run({
            ...feed,
            history: new ort.Tensor(
              "float32",
              visualStateContext(history),
              [1, 4, 12],
            ),
          })
        : auxiliary;
    for (const [name, length] of Object.entries({
      predicates: 3,
      recovery: 4,
      outcome: 2,
    }))
      if (
        (name === "outcome" ? auxiliary : stateHeads)[name].data.length !==
          length ||
        Array.from(
          (name === "outcome" ? auxiliary : stateHeads)[name]
            .data as Float32Array,
        ).some((v) => !Number.isFinite(v))
      )
        throw new Error("Controller returned invalid auxiliary output");
    return {
      index,
      scores,
      predicates: Array.from(stateHeads.predicates.data as Float32Array),
      recovery: Array.from(stateHeads.recovery.data as Float32Array),
      outcome: Array.from(auxiliary.outcome.data as Float32Array),
      latencyMs: performance.now() - start,
    };
  }
  async close() {
    await this.session.release();
  }
}
export class ModelRegistry {
  constructor(private store: Store) {}
  list(): ModelVersion[] {
    return this.store.list("models");
  }
  register(id: string, path: string, seed: number) {
    const digest = hash(readFileSync(path));
    const existing = this.store.get<ModelVersion>("models", id);
    if (existing && existing.hash !== digest)
      throw new Error("Model versions are immutable; use a new candidate ID");
    const candidateReport = join(dirname(path), "report.json");
    const report = JSON.parse(
      readFileSync(
        existsSync(candidateReport)
          ? candidateReport
          : join("models", String(seed), "report.json"),
        "utf8",
      ),
    );
    if (
      report.seed !== seed ||
      typeof report.parameters !== "number" ||
      !Number.isFinite(report.parameters) ||
      report.parameters < 1 ||
      report.parameters > 10000000 ||
      !Number.isFinite(report.onnxMaxError) ||
      report.onnxMaxError < 0 ||
      (report.contextVersion &&
        ![1, 2, 3, 4].includes(report.contextVersion)) ||
      (report.candidateDescriptorVersion !== undefined &&
        (report.candidateDescriptorVersion !== 2 ||
          report.contextVersion !== 4))
    )
      throw new Error("Model report does not match its candidate");
    const model: ModelVersion = {
      schemaVersion: 1,
      id,
      hash: digest,
      parameters: report.parameters,
      format: "onnx",
      seed,
      status: "candidate",
      metrics: {
        parity:
          report.sha256 && report.sha256 !== digest ? -1 : report.onnxMaxError,
        ...(report.contextVersion
          ? { contextVersion: report.contextVersion }
          : {}),
        ...(report.candidateDescriptorVersion
          ? { candidateDescriptorVersion: report.candidateDescriptorVersion }
          : {}),
      },
    };
    if (existing) {
      if (canonical({ ...existing, status: "candidate" }) !== canonical(model))
        throw new Error(
          "Model version metadata is immutable; use a new candidate ID",
        );
      return existing;
    }
    this.store.put("models", id, model);
    this.store.put("model-path", id, path);
    return model;
  }
  activate(id: string) {
    const model = this.store.get<ModelVersion>("models", id);
    if (!model) throw new Error("Unknown candidate");
    const path = this.store.get<string>("model-path", id)!;
    if (hash(readFileSync(path)) !== model.hash)
      throw new Error("Model hash changed");
    const qualification = this.store.get<{
      directory: string;
      qualification: FollowupQualification;
    }>("model-qualifications", model.hash);
    if (qualification) {
      const verified = verifyFollowupAudit(qualification.directory);
      if (
        verified.resultsHash !== qualification.qualification.resultsHash ||
        (model.metrics.contextVersion || 1) !== verified.contextVersion ||
        (model.metrics.candidateDescriptorVersion || 1) !==
          (verified.candidateDescriptorVersion || 1) ||
        !verified.models.some(
          (candidate) =>
            candidate.seed === model.seed &&
            candidate.sha256 === model.hash &&
            candidate.parameters === model.parameters,
        )
      )
        throw new Error(
          "Model does not match its scoped followup qualification",
        );
      this.setActive(id);
      return this.store.get<ModelVersion>("models", id)!;
    }
    if ((model.metrics.contextVersion || 1) >= 2)
      throw new Error(
        "Live-context candidate requires its own trusted scoped followup qualification",
      );
    const report = existsSync("evidence/results.json")
      ? JSON.parse(readFileSync("evidence/results.json", "utf8"))
      : null;
    if (report?.learningBenefit !== "PASS" || report?.falseSuccess !== 0)
      throw new Error("Frozen evaluation promotion gate has not passed");
    verifySealedAudit();
    if (
      !report.models.some(
        (m: any) =>
          m.seed === model.seed &&
          m.sha256 === model.hash &&
          m.parameters === model.parameters &&
          m.onnxMaxError < 0.0001,
      )
    )
      throw new Error("Candidate was not tested by the sealed audit");
    this.setActive(id);
    return this.store.get<ModelVersion>("models", id)!;
  }
  importFollowupAudit(directory: string) {
    const qualification = verifyFollowupAudit(directory);
    this.store.transaction(() => {
      for (const model of qualification.models)
        this.store.put("model-qualifications", model.sha256, {
          directory,
          qualification,
        });
    });
    return qualification;
  }
  private setActive(id: string) {
    this.store.transaction(() => {
      const old = this.store.get<string>("model", "active") || "fixed";
      this.store.put("model", "previous", old);
      this.store.put("model", "active", id);
      for (const model of this.list()) {
        if (model.id === id) model.status = "active";
        else if (model.status === "active") model.status = "retired";
        this.store.put("models", model.id, model);
      }
    });
  }
  rollback() {
    const previous = this.store.get<string>("model", "previous") || "fixed";
    if (previous === "fixed") this.setActive(previous);
    else this.activate(previous);
    return { active: previous };
  }
}
