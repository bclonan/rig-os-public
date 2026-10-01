import { trainingPython } from "../learner/python.js";
import Fastify from "fastify";
import { verifySealedAudit } from "../learner/audit.js";
import staticPlugin from "@fastify/static";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import type { Runtime } from "../runtime/index.js";
import { OllamaProvider } from "../providers/index.js";
import { compileIntent } from "../compiler/intent.js";
import { compileDemonstrations } from "../compiler/experience.js";
import { Recorder, type Demonstration } from "../recorder/index.js";
import { ModelRegistry } from "../learner/index.js";
import { exportDataset, importDataset } from "../recorder/bundle.js";
import { hash, canonical } from "../storage/index.js";
import { structuredTask } from "../compiler/intent.js";
import { randomUUID } from "node:crypto";
import { DesktopRouter } from "../adapters/desktop.js";
import { UnixAdapter } from "../adapters/unix.js";
import { reviewDesktop } from "../assistant/runner.js";
import { AdaptiveSelector } from "../learner/selector.js";
import { LocalVisionAssessor } from "../providers/vision.js";
import { ScopedEvidenceCache } from "../predicates/cache.js";
import { createDrawingPlan } from "./drawing.js";
import { checkSkill } from "../skills/index.js";
import {
  previewSkillMigration,
  commitSkillMigration,
  skillBundleImportRequest,
  skillMigrationRequest,
} from "../skills/bundle.js";
import {
  artifactConfiguration,
  artifactSkill,
  artifactTask,
} from "./artifacts.js";
import {
  compileWorkflowLibrary,
  importWorkflowLibrary,
} from "../compiler/library.js";
export async function service(
  runtime: Runtime,
  options: {
    /** Trusted embedding configuration, never accepted from an HTTP request. */
    trainingCommand?: { executable: string; args: string[] };
    drawingProvider?: (
      model: string,
    ) => import("../contracts/ports.js").ModelProvider;
  } = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  const fixture =
    runtime.adapter instanceof DesktopRouter
      ? runtime.adapter.browser
      : runtime.adapter;
  const token = runtime.store.token();
  let stopping = false;
  const serviceAbort = new AbortController();
  const semanticCache = new ScopedEvidenceCache<any>();
  for (const previous of runtime.store.list<any>("jobs")) {
    if (previous.status === "running")
      runtime.store.put("jobs", previous.id, {
        ...previous,
        status: "interrupted",
        output: "The previous coordinator stopped before this job completed.",
      });
  }
  const recorder = new Recorder(runtime.store);
  const models = new ModelRegistry(runtime.store);
  for (const seed of [17, 41, 73])
    if (
      existsSync(`models/${seed}/trained.onnx`) &&
      !models.list().some((m) => m.id === "owned-" + seed)
    )
      models.register("owned-" + seed, `models/${seed}/trained.onnx`, seed);
  const pending = new Set<string>();
  const streams = new Map<import("node:http").ServerResponse, () => void>();
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' blob:; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      );
    const host = req.headers.host;
    if (
      !host ||
      !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?$/i.test(host)
    ) {
      return reply.code(403).send({ error: "Invalid Host header" });
    }
    if (
      req.headers.origin &&
      req.headers.origin !== "http://" + req.headers.host
    )
      return reply.code(403).send({ error: "Origin denied" });
    if (!req.routeOptions.url?.startsWith("/api/")) return;
    if (typeof req.headers["x-correlation-id"] === "string")
      reply.header("x-correlation-id", req.headers["x-correlation-id"]);
    const got = Buffer.from(
      (req.headers.authorization || "").replace(/^Bearer /, ""),
    );
    const expected = Buffer.from(token);
    if (got.length !== expected.length || !timingSafeEqual(got, expected))
      return reply.code(401).send({ error: "Local token required" });
    if (
      stopping &&
      req.method === "POST" &&
      req.routeOptions.url !== "/api/service/shutdown"
    )
      return reply.code(503).send({ error: "Runtime is shutting down" });
    if (
      req.method === "POST" &&
      (!req.headers["idempotency-key"] || !req.headers["x-correlation-id"])
    )
      return reply
        .code(400)
        .send({ error: "Correlation and idempotency headers required" });
  });
  app.setErrorHandler((e, _req, reply) =>
    reply.code(400).send({ error: String(e) }),
  );
  app.addHook("preHandler", async (req, reply) => {
    if (
      req.method !== "POST" ||
      !req.routeOptions.url?.startsWith("/api/") ||
      req.routeOptions.url === "/api/tasks"
    )
      return;
    const key =
      req.routeOptions.url +
      ":" +
      canonical(req.params) +
      ":" +
      String(req.headers["idempotency-key"]);
    const digest = hash(canonical(req.body));
    const old =
      runtime.store.get<any>("api-dedup", key) ||
      runtime.store.get<any>(
        "api-dedup",
        req.url + ":" + String(req.headers["idempotency-key"]),
      );
    if (old) {
      if (old.digest !== digest)
        return reply
          .code(409)
          .send({ error: "Idempotency key reused with different payload" });
      if (typeof old.correlationId === "string")
        reply.header("x-correlation-id", old.correlationId);
      return reply.code(old.status).type("application/json").send(old.payload);
    }
    if (pending.has(key))
      return reply
        .code(409)
        .send({ error: "Matching request is still running" });
    pending.add(key);
    (req as any).dedup = {
      key,
      digest,
      correlationId: String(req.headers["x-correlation-id"]),
    };
  });
  app.addHook("onSend", async (req, reply, payload) => {
    const d = (req as any).dedup;
    if (d) {
      pending.delete(d.key);
      if (reply.statusCode < 400 && typeof payload === "string")
        runtime.store.put("api-dedup", d.key, {
          digest: d.digest,
          correlationId: d.correlationId,
          payload,
          status: reply.statusCode,
        });
    }
    return payload;
  });
  app.get("/api/service", async () => ({
    name: "computer-use-runtime",
    pid: process.pid,
    storeId: hash(runtime.store.root),
    status: stopping ? "stopping" : "running",
    activeTasks: runtime.store
      .runs()
      .filter((r) => ["running", "queued"].includes(r.status)).length,
  }));
  app.post("/api/service/shutdown", async (_req, reply) => {
    stopping = true;
    reply.raw.once("finish", () =>
      setImmediate(() => {
        void app.close().catch((error) => {
          console.error("Shutdown failed:", String(error));
          process.exitCode = 1;
        });
      }),
    );
    return { status: "stopping" };
  });
  app.get("/api/capabilities", async () => ({
    host: fixture.host,
    session: fixture.session,
    identity: fixture.identity,
    operations: fixture.capabilities,
    providers: await OllamaProvider.discover(),
    activeModel: runtime.store.get("model", "active") || "fixed",
    hostIntegration: "UNVERIFIED",
    native:
      runtime.adapter instanceof DesktopRouter && runtime.adapter.native
        ? "desktop assistant available"
        : "desktop assistant unavailable",
  }));
  app.get("/api/desktop/windows", async () =>
    runtime.adapter instanceof DesktopRouter
      ? runtime.adapter.windows()
      : {
          available: false,
          reason: "Desktop adapter is not configured",
          windows: [],
        },
  );
  app.post("/api/desktop/consent", async () => {
    const adapter =
      runtime.adapter instanceof DesktopRouter
        ? runtime.adapter.native
        : undefined;
    if (!(adapter instanceof UnixAdapter))
      throw new Error("Desktop portal consent is unavailable on this host");
    return runtime.configureEnvironment(() => adapter.requestConsent());
  });
  app.post("/api/desktop/consent/cancel", async () => {
    const adapter =
      runtime.adapter instanceof DesktopRouter
        ? runtime.adapter.native
        : undefined;
    if (!(adapter instanceof UnixAdapter))
      throw new Error("Desktop portal consent is unavailable on this host");
    return adapter.cancelConsent();
  });
  app.post("/api/artifact-tasks", async (req: any) => {
    if (!(runtime.adapter instanceof DesktopRouter))
      throw new Error("Workspace tasks require the standalone service router");
    const { goal, ...input } = req.body || {};
    if (typeof goal !== "string" || !goal.trim() || goal.length > 4000)
      throw new Error("Enter an artifact request of at most 4000 characters");
    const configuration = artifactConfiguration(input);
    const operationKey = hash(
      "artifact:" + String(req.headers["idempotency-key"]),
    );
    const inputHash = hash(canonical({ goal: goal.trim(), ...configuration }));
    const prior = runtime.store.get<{
      id: string;
      correlationId: string;
      inputHash: string;
    }>("artifact-requests", operationKey);
    if (prior && prior.inputHash !== inputHash)
      throw new Error("Idempotency key reused with different artifact payload");
    const request = prior ?? {
      id: randomUUID(),
      correlationId: String(req.headers["x-correlation-id"]),
      inputHash,
    };
    if (!prior) runtime.store.put("artifact-requests", operationKey, request);
    const id = request.id;
    const adapter = runtime.adapter.configureArtifact(id, configuration);
    const task = artifactTask(id, request.correlationId, goal.trim(), adapter);
    runtime.registry.put(artifactSkill(adapter));
    const run = runtime.submit(
      task,
      "artifact:" + String(req.headers["idempotency-key"]),
    );
    void runtime.execute(run.id);
    return run;
  });
  app.get("/api/artifact-tasks/:id", async (req: any) => {
    const run = runtime.store.run(req.params.id);
    if (!run.contract.method?.startsWith("artifact."))
      throw new Error("Not an artifact task");
    return {
      run,
      spec: runtime.store.get<import("./artifacts.js").ArtifactConfiguration>(
        "artifact-configurations",
        run.id,
      )?.spec,
      state: runtime.store.get("artifact-state", run.id),
      attempts: runtime.store
        .list<any>("artifact-attempts")
        .filter((attempt) => attempt.runId === run.id)
        .sort((a, b) => a.sequence - b.sequence),
    };
  });
  app.get("/api/artifact-tasks/:id/download", async (req: any, reply) => {
    const run = runtime.store.run(req.params.id);
    if (
      run.status !== "succeeded" ||
      !run.contract.method?.startsWith("artifact.")
    )
      throw new Error(
        "Only independently verified completed artifacts can be downloaded as a result",
      );
    const state = runtime.store.get<any>("artifact-state", run.id);
    if (
      !state?.verification?.valid ||
      state.verification.outputHash !== state.outputHash
    )
      throw new Error("Artifact verification binding is absent");
    const config = runtime.store.get<
      import("./artifacts.js").ArtifactConfiguration
    >("artifact-configurations", run.id)!;
    const bytes = runtime.store.artifactRead(state.output);
    if (hash(bytes) !== state.outputHash)
      throw new Error("Verified artifact bytes changed");
    reply.header(
      "Content-Disposition",
      'attachment; filename="' +
        (config.spec.kind === "csv_transform" ? "result.csv" : "result.json") +
        '"',
    );
    return reply
      .type(
        config.spec.kind === "csv_transform" ? "text/csv" : "application/json",
      )
      .send(bytes);
  });
  app.post("/api/desktop/tasks", async (req: any) => {
    if (!(runtime.adapter instanceof DesktopRouter))
      throw new Error("Desktop adapter is not configured");
    const body = req.body;
    if (
      typeof body?.goal !== "string" ||
      !body.goal.trim() ||
      body.goal.length > 4000 ||
      typeof body.model !== "string" ||
      !body.model ||
      body.model.length > 200
    )
      throw new Error(
        "Choose a local model and enter a task of at most 4000 characters",
      );
    if (body.vision !== undefined && typeof body.vision !== "boolean")
      throw new Error("Invalid screenshot setting");
    if (
      body.scope !== undefined &&
      !["window", "computer"].includes(body.scope)
    )
      throw new Error("Choose This computer or One window");
    const computer = body.scope === "computer";
    const desktop = await runtime.adapter.windows();
    if (!desktop.available) throw new Error(desktop.reason);
    const window = desktop.windows.find(
      (w: any) => w.handle === body.handle && w.pid === body.pid,
    );
    if (!computer && !window)
      throw new Error("The selected window has closed. Refresh open apps.");
    const id = randomUUID();
    const task = {
      schemaVersion: 1,
      id,
      correlationId: String(req.headers["x-correlation-id"]),
      requester: "local-user",
      goal: body.goal.trim(),
      target: {
        host: desktop.host,
        session: desktop.session,
        identity: computer
          ? `computer:${desktop.session}`
          : String(window!.handle),
      },
      parameters: {
        desktopScope: computer ? "computer" : "window",
        ...(computer
          ? {}
          : { windowPid: window!.pid, windowTitle: window!.title }),
        plannerModel: body.model,
        vision: body.vision === true,
      },
      effects: computer ? ["edit", "save", "navigate"] : ["edit", "save"],
      requirements: [
        {
          name: "action_review",
          value: "Every action requires explicit review",
          origin: "system_policy",
        },
      ],
      unresolved: [],
      method: "desktop.assistant",
      expected: {},
      budgets: { steps: 40, deadlineMs: 3600000 },
    };
    const run = runtime.submit(
      task,
      "desktop:" + String(req.headers["idempotency-key"]),
    );
    void runtime.execute(run.id);
    return run;
  });
  app.post("/api/drawing-plans", async (req: any) =>
    createDrawingPlan(
      runtime,
      req.body,
      String(req.headers["idempotency-key"]),
      options.drawingProvider || ((model) => new OllamaProvider(model)),
      serviceAbort.signal,
    ),
  );
  app.post("/api/drawing-plans/:id/execute", async (req: any) => {
    const plan = runtime.store.get<any>("drawing-plans", req.params.id);
    if (!plan?.ready || plan.contractHash !== hash(canonical(plan.task)))
      throw new Error("Frozen drawing plan is unavailable or changed");
    runtime.registry.put(checkSkill(plan.skill));
    const run = runtime.submit(plan.task, "drawing:" + plan.id);
    void runtime.execute(run.id);
    return run;
  });
  app.post("/api/desktop/tasks/:id/review", async (req: any) =>
    reviewDesktop(runtime, req.params.id, req.body),
  );
  app.get("/api/tasks", async () => runtime.store.runs());
  app.post("/api/tasks", async (req) => {
    const run = runtime.submit(
      req.body,
      String(req.headers["idempotency-key"]),
    );
    void runtime.execute(run.id);
    return run;
  });
  app.get("/api/tasks/:id", async (req: any) =>
    runtime.store.run(req.params.id),
  );
  app.post("/api/tasks/:id/control", async (req: any) =>
    runtime.control(req.params.id, req.body.command),
  );
  app.get("/api/tasks/:id/evidence", async (req: any) =>
    runtime.store.events(0, req.params.id),
  );
  app.get("/api/tasks/:id/advice", async (req: any) =>
    runtime.configureEnvironment(async () => {
      const run = runtime.store.run(req.params.id);
      await runtime.adapter.prepare?.(run.contract);
      const observation = await runtime.observe(run.contract);
      const selector = new AdaptiveSelector(
        runtime.store,
        runtime.adapter.capabilities,
      );
      try {
        return await selector.assess(run.contract, observation);
      } finally {
        await selector.close();
      }
    }),
  );
  app.post("/api/desktop/tasks/:id/assess", async (req: any) => {
    const run = runtime.store.run(req.params.id);
    const body = req.body;
    if (
      (run.contract.method !== "desktop.assistant" &&
        !run.contract.method?.startsWith("drawing.")) ||
      !["needs_review", "completed_by_user", "paused"].includes(run.status)
    )
      throw new Error(
        "Pause or finish desktop execution before assessing the canvas",
      );
    if (
      typeof body?.subject !== "string" ||
      !body.subject.trim() ||
      body.subject.length > 100 ||
      typeof body.model !== "string" ||
      !body.model ||
      body.model.length > 200
    )
      throw new Error(
        "Choose a local vision model and enter the subject to inspect",
      );
    const observation = await runtime.configureEnvironment(async () => {
      await runtime.adapter.prepare?.(run.contract);
      return runtime.observe(run.contract);
    });
    if (
      typeof observation.facts.canvasImage !== "string" ||
      typeof observation.facts.canvasBounds !== "string"
    )
      throw new Error("This task has no verified target canvas crop");
    const image = runtime.store.artifactRead(observation.facts.canvasImage);
    if (hash(image) !== observation.facts.canvasImage)
      throw new Error("Scoped canvas bytes changed");
    const assessment = await new LocalVisionAssessor(body.model).assess(
      body.subject.trim(),
      image,
      serviceAbort.signal,
      { cache: semanticCache, observation },
    );
    const result = {
      ...assessment,
      subject: body.subject.trim(),
      at: Date.now(),
      inputHash: hash(image),
      target: observation.target,
      observationId: observation.id,
      observedAt: observation.at,
      revision: observation.revision,
      canvasBounds: observation.facts.canvasBounds,
      statusChanged: false,
    };
    runtime.store.put("semantic-assessments", run.id, result);
    runtime.event(run, "semantic_assessment", result);
    return result;
  });
  app.get(
    "/api/desktop/tasks/:id/assessment",
    async (req: any) =>
      runtime.store.get("semantic-assessments", req.params.id) || {
        available: false,
      },
  );
  app.post("/api/takeover", async () => {
    await runtime.takeover();
    return { status: "manual" };
  });
  app.post("/api/return", async () => {
    await runtime.returnControl();
    return { status: "returned" };
  });
  app.get("/api/observation", async () =>
    runtime.adapter instanceof DesktopRouter
      ? runtime.adapter.browser.observe()
      : runtime.adapter.observe(),
  );
  app.get("/api/artifacts/:hash", async (req: any, reply) =>
    reply.type("image/png").send(runtime.store.artifactRead(req.params.hash)),
  );
  app.get("/api/skills", async () => runtime.registry.list());
  app.post("/api/skills/import", async (req) =>
    runtime.registry.import(req.body),
  );
  app.post("/api/skills/migrations/preview", async (req) => {
    const { source, route } = skillMigrationRequest(req.body);
    return previewSkillMigration(source, route, runtime.registry);
  });
  app.post("/api/skills/migrate", async (req) => {
    const { source, route } = skillMigrationRequest(req.body);
    return commitSkillMigration(runtime.store, source, route, runtime.registry);
  });
  app.post("/api/skills/bundles/import", async (req) =>
    runtime.registry.importBundle(skillBundleImportRequest(req.body)),
  );
  app.get("/api/skills/:id/export", async (req: any) => {
    if (Object.keys(req.query).some((key) => key !== "schemaVersion"))
      throw new Error("Unsupported skill export fields");
    if (req.query.schemaVersion === "2")
      return runtime.registry.exportBundle(req.params.id);
    if (
      req.query.schemaVersion !== undefined &&
      req.query.schemaVersion !== "1"
    )
      throw new Error("Unsupported skill export schema version");
    return runtime.registry.get(req.params.id);
  });
  app.post("/api/skills/:id/rollback", async (req: any) =>
    runtime.registry.rollback(req.params.id, req.body.hash),
  );
  app.post("/api/skills/:id/test", async (req: any) => {
    if (
      fixture.identity !== "browser-fixture-v1" ||
      runtime.store.runs().some((r) => r.status === "running")
    )
      throw new Error(
        "Candidate testing requires an idle resettable form fixture",
      );
    const candidate = runtime.registry.get(req.params.id);
    if (
      candidate.inputs.name !== "string" ||
      candidate.provenance.uncertain.length
    )
      throw new Error(
        "Candidate needs a known form input and resolved uncertainties",
      );
    const runs = [];
    for (const [index, name] of [
      "Regression Aspen " + Date.now(),
      "Regression Elm " + Date.now(),
      "Regression Ash " + Date.now(),
    ].entries()) {
      const task = structuredTask(
        "Validate candidate on an unseen form input",
        {
          host: fixture.host,
          session: fixture.session,
          identity: fixture.identity,
        },
        { name },
        candidate.id,
      );
      const run = await runtime.testCandidate(task, candidate, () =>
        (fixture as any).reset("ready", index % 2 ? "shift" : "base"),
      );
      runs.push(run.id);
      if (run.status !== "succeeded")
        throw new Error("Candidate rejected by variation " + run.id);
    }
    return runtime.registry.publish(candidate.id, runs);
  });
  app.post("/api/intent", async (req: any) => {
    const caps = (await OllamaProvider.discover()) as any;
    const model = req.body.model || caps.models?.[0]?.name;
    if (!model) throw new Error("Local language provider unavailable");
    return compileIntent(
      req.body.goal,
      {
        host: fixture.host,
        session: fixture.session,
        identity: fixture.identity,
      },
      ["edit"],
      runtime.registry.list(),
      new OllamaProvider(model),
      serviceAbort.signal,
    );
  });
  app.post("/api/record", async (req: any) => recorder.capture(req.body.runId));
  app.get("/api/record", async () => recorder.export());
  app.get("/api/datasets/export", async () => exportDataset(runtime.store));
  app.post("/api/datasets/import", async (req) =>
    importDataset(runtime.store, req.body),
  );
  app.post("/api/correct", async (req: any) =>
    recorder.correct(
      req.body.id,
      req.body.step,
      req.body.label,
      "authenticated-user",
    ),
  );
  app.post("/api/compile", async (req: any) => {
    const ids =
      req.body.demonstrationIds ??
      runtime.store
        .list<Demonstration>("demonstrations")
        .filter((d) => d.verified)
        .map((d) => d.id);
    if (
      !Array.isArray(ids) ||
      ids.some((id) => typeof id !== "string") ||
      ids.length > 100
    )
      throw new Error("Select three or more demonstration IDs to compile");
    const demos = ids.map((id: string) => {
      const demo = runtime.store.get<Demonstration>("demonstrations", id);
      if (!demo) throw new Error("Demonstration not found: " + id);
      return demo;
    });
    if (req.body.library === true) {
      const library = compileWorkflowLibrary(demos, "library." + randomUUID());
      for (const dependency of library.dependencies)
        runtime.registry.put(dependency);
      for (const root of library.roots) runtime.registry.put(root);
      runtime.store.put("workflow-libraries", library.roots[0].id, library);
      return library;
    }
    const skill = compileDemonstrations(demos);
    runtime.registry.put(skill);
    return skill;
  });
  app.get("/api/libraries", async () =>
    runtime.store.list("workflow-libraries"),
  );
  app.post("/api/libraries/import", async (req) => {
    const library = importWorkflowLibrary(req.body);
    runtime.store.transaction(() => {
      const pending = [...library.dependencies, ...library.roots];
      while (pending.length) {
        const index = pending.findIndex((skill) =>
          skill.dependencies.every((id) => runtime.store.get("skills", id)),
        );
        if (index < 0)
          throw new Error("Library dependencies cannot be resolved");
        runtime.registry.import(pending.splice(index, 1)[0]);
      }
      runtime.store.put("workflow-libraries", library.roots[0].id, library);
    });
    return library;
  });
  app.get("/api/models", async () => new ModelRegistry(runtime.store).list());
  app.post("/api/models/activate", async (req: any) =>
    new ModelRegistry(runtime.store).activate(req.body.id),
  );
  app.post("/api/models/rollback", async () =>
    new ModelRegistry(runtime.store).rollback(),
  );
  let job: ReturnType<typeof spawn> | undefined;
  let jobFinished: Promise<void> | undefined;
  app.post("/api/jobs", async (req: any) => {
    if (job) throw new Error("A learning job is already running");
    const type = req.body.type;
    if (type === "verify-audit") {
      const id = randomUUID();
      const { report: _report, ...verification } = verifySealedAudit();
      const record = {
        id,
        type,
        status: "finished",
        output: JSON.stringify(verification, null, 2),
      };
      runtime.store.put("jobs", id, record);
      return record;
    }
    if (!["train", "train-recordings", "evaluate"].includes(type))
      throw new Error("Unknown job");
    if (type === "evaluate" && existsSync("evidence/audit-sealed.json"))
      throw new Error(
        "The audit is sealed. New candidates require a separate frozen protocol and evidence directory.",
      );
    const id = randomUUID();
    const training = type === "train" || type === "train-recordings";
    const command = training
      ? options.trainingCommand?.executable || trainingPython()
      : process.execPath;
    const args = training
      ? options.trainingCommand?.args || ["learner/train.py"]
      : ["--import", "tsx", "evaluation/audit.ts"];
    const environment = { ...process.env };
    if (type === "train-recordings") {
      const directory = resolve(runtime.store.root, "jobs", id);
      mkdirSync(directory, { recursive: true });
      const bundle = exportDataset(runtime.store, { unredacted: true });
      if (!bundle.demonstrations.length)
        throw new Error(
          "Record a fixture task before training from recordings",
        );
      const path = resolve(directory, "dataset.json");
      writeFileSync(path, JSON.stringify(bundle));
      environment.CUR_DATASET_BUNDLE = path;
      environment.CUR_MODEL_DIR = resolve(directory, "models");
    }
    job = spawn(command, args, {
      env: environment,
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    runtime.store.put("jobs", id, { id, type, status: "running" });
    let output = "";
    job.stdout?.on("data", (d) => {
      output = (output + String(d)).slice(-32000);
    });
    job.stderr?.on("data", (d) => {
      output = (output + String(d)).slice(-32000);
    });
    job.once("error", (error) => {
      output += String(error);
    });
    const currentJob = job;
    jobFinished = new Promise((resolveJob) => {
      currentJob.once("close", (code) => {
        runtime.store.put("jobs", id, {
          id,
          type,
          status: stopping ? "cancelled" : code === 0 ? "finished" : "failed",
          output: output.slice(-32000),
        });
        job = undefined;
        resolveJob();
      });
    });
    return { id, type, status: "running" };
  });
  app.get("/api/jobs", async () => runtime.store.list("jobs"));
  app.get("/api/results", async () =>
    existsSync("evidence/results.json")
      ? JSON.parse(readFileSync("evidence/results.json", "utf8"))
      : { status: "NOT RUN" },
  );
  app.get("/api/events", async (req: any, reply) => {
    let cursor = Number(req.query.after || 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new Error("Invalid cursor");
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const flush = () => {
      if (reply.raw.writableNeedDrain || reply.raw.destroyed) return;
      for (const e of runtime.store.events(cursor)) {
        const writable = reply.raw.write(
          `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`,
        );
        cursor = e.seq;
        if (!writable) break;
      }
    };
    flush();
    const timer = setInterval(flush, 200);
    const heartbeat = setInterval(
      () => reply.raw.write(": heartbeat\n\n"),
      15000,
    );
    const cleanup = () => {
      clearInterval(timer);
      clearInterval(heartbeat);
      streams.delete(reply.raw);
    };
    streams.set(reply.raw, cleanup);
    reply.raw.once("close", cleanup);
  });
  if (existsSync("dist/console"))
    await app.register(staticPlugin, {
      root: resolve("dist/console"),
      prefix: "/",
    });
  app.addHook("preClose", async () => {
    stopping = true;
    serviceAbort.abort(new Error("Runtime is shutting down"));
    for (const [stream, cleanup] of streams) {
      cleanup();
      stream.end();
    }
    streams.clear();
    // Runtime.close reports a retained drain failure after all cleanup hooks finish.
    await runtime.pauseForShutdown().catch(() => {});
    if (job) {
      const currentJob = job;
      currentJob.kill();
      const force = setTimeout(() => currentJob.kill("SIGKILL"), 3000);
      try {
        await jobFinished;
      } finally {
        clearTimeout(force);
      }
    }
  });
  app.addHook("onClose", async () => {
    await runtime.close();
  });
  return app;
}
