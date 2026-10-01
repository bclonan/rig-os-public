import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Store, hash } from "../src/storage/index.js";
import {
  PermissionedTools,
  publicResearchAddress,
  type ToolRequest,
} from "../src/tools/index.js";
import { applyRetention, previewRetention } from "../src/tools/retention.js";
import { exportDataset, importDataset } from "../src/recorder/bundle.js";
import { structuredTask } from "../src/compiler/intent.js";
const request = (
  operation: ToolRequest["operation"],
  args: ToolRequest["args"],
): ToolRequest => ({
  id: randomUUID(),
  runId: "run",
  correlationId: "correlation",
  requester: "user",
  operation,
  args,
  deadline: Date.now() + 5000,
});

test("workspace grants constrain writes, idempotency, overwrites, protected files and symlinks", async () => {
  const base = mkdtempSync(join(tmpdir(), "cur-tools-")),
    root = join(base, "workspace");
  mkdirSync(root);
  const store = new Store(join(base, "store"));
  try {
    const tools = new PermissionedTools(store, {
      root,
      exclusiveRoot: true,
      allowedOrigins: [],
      permissions: ["workspace_read", "workspace_write"],
    });
    const first = request("workspace_write", {
      path: "output/message.txt",
      content: "constructed output",
    });
    const receipt = await tools.execute(first);
    assert.equal(
      readFileSync(join(root, "output/message.txt"), "utf8"),
      "constructed output",
    );
    assert.deepEqual(await tools.execute(first), receipt);
    // Simulate interruption after the atomic filesystem effect but before its receipt commit.
    store.db
      .prepare("DELETE FROM kv WHERE namespace='tool-receipts' AND key=?")
      .run(hash(first.runId + ":" + first.id));
    assert.equal((await tools.execute(first)).sha256, receipt.sha256);
    assert.equal(
      store.events(0, "run").filter((e) => e.type === "tool_reconciled").length,
      1,
    );
    await assert.rejects(
      () =>
        tools.execute({
          ...first,
          args: { ...first.args, content: "changed" },
        }),
      /reused/,
    );
    await assert.rejects(
      () =>
        tools.execute(
          request("workspace_write", {
            path: "output/message.txt",
            content: "replacement",
          }),
        ),
      /expectedHash/,
    );
    await tools.execute(
      request("workspace_write", {
        path: "output/message.txt",
        content: "replacement",
        expectedHash: receipt.sha256,
      }),
    );
    assert.equal(
      (
        await tools.execute(
          request("workspace_read", { path: "output/message.txt" }),
        )
      ).content,
      "replacement",
    );
    for (const path of [
      "../escape.txt",
      "C:\\escape.txt",
      "file.txt:stream",
      "evaluation/examiner.py",
      "acceptance.json",
      "docs/completion-contract-v1/contract.json",
      ".env",
      "folder/%2e%2e/escape",
    ])
      await assert.rejects(
        () =>
          tools.execute(request("workspace_write", { path, content: "bad" })),
        /path|protected|escape/i,
      );
    const outside = join(base, "outside");
    mkdirSync(outside);
    symlinkSync(
      outside,
      join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      () =>
        tools.execute(
          request("workspace_write", {
            path: "linked/escape.txt",
            content: "bad",
          }),
        ),
      /symlink/,
    );
    const denied = new PermissionedTools(store, {
      root,
      exclusiveRoot: true,
      allowedOrigins: [],
      permissions: ["workspace_read"],
    });
    await assert.rejects(
      () =>
        denied.execute(
          request("workspace_write", { path: "denied.txt", content: "bad" }),
        ),
      /denied/,
    );
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(() =>
      tools.execute(
        request("workspace_read", { path: "output/message.txt" }),
        abort.signal,
      ),
    );
    assert.ok(store.events(0, "run").some((e) => e.type === "tool_failed"));
    assert.equal(
      store.events(0, "run").filter((e) => e.type === "tool_completed").length,
      3,
    );
  } finally {
    store.close();
  }
});

test("research reads exact origins, refuses redirects/private DNS/secrets and bounds responses", async () => {
  const base = mkdtempSync(join(tmpdir(), "cur-research-")),
    store = new Store(join(base, "store"));
  let leaks = 0;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/plain");
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/leak" });
      res.end();
    } else if (req.url === "/leak") {
      leaks++;
      res.end("leaked");
    } else if (req.url === "/large") res.end("x".repeat(1000));
    else res.end("independent source says 7 + 8 = 15");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  try {
    const tools = new PermissionedTools(store, {
      root: base,
      allowedOrigins: [origin],
      permissions: ["research_read"],
      allowLoopbackResearch: true,
      maxBytes: 128,
    });
    const result = await tools.execute(
      request("research_read", { url: origin + "/source" }),
    );
    assert.equal(
      store.artifactRead(result.artifact).toString(),
      result.content,
    );
    assert.equal(result.source.location, origin + "/source");
    await assert.rejects(
      () =>
        tools.execute(request("research_read", { url: origin + "/redirect" })),
      /redirects/,
    );
    assert.equal(leaks, 0);
    await assert.rejects(
      () =>
        tools.execute(
          request("research_read", { url: origin + "/source?token=secret" }),
        ),
      /query/,
    );
    await assert.rejects(
      () => tools.execute(request("research_read", { url: origin + "/large" })),
      /budget/,
    );
    const privateDenied = new PermissionedTools(store, {
      root: base,
      allowedOrigins: [origin],
      permissions: ["research_read"],
    });
    await assert.rejects(
      () =>
        privateDenied.execute(
          request("research_read", { url: origin + "/source" }),
        ),
      /private/,
    );
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
    ])
      assert.equal(publicResearchAddress(address), false);
    assert.equal(publicResearchAddress("8.8.8.8"), true);
  } finally {
    store.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("retention previews only old unreferenced artifacts and requires unchanged confirmed plan", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-retention-")));
  try {
    const protectedId = store.artifact("referenced evidence"),
      orphan = store.artifact("old orphan");
    const old = new Date(Date.now() - 3 * 86400000);
    for (const id of [protectedId, orphan])
      utimesSync(join(store.root, "artifacts", id), old, old);
    store.put("demonstrations", "demo", { image: protectedId });
    const plan = previewRetention(store, Date.now() - 2 * 86400000);
    assert.deepEqual(
      plan.delete.map((d) => d.artifact),
      [orphan],
    );
    assert.throws(() => applyRetention(store, plan, "wrong"), /confirmation/);
    store.put("new-reference", "race", { image: orphan });
    assert.throws(
      () => applyRetention(store, plan, plan.digest),
      /references changed/,
    );
    assert.deepEqual(
      store.artifactRead(protectedId),
      Buffer.from("referenced evidence"),
    );
    const second = store.artifact("second old orphan");
    utimesSync(join(store.root, "artifacts", second), old, old);
    const fresh = previewRetention(store, Date.now() - 2 * 86400000);
    assert.deepEqual(applyRetention(store, fresh, fresh.digest).removed, [
      second,
    ]);
    assert.deepEqual(store.artifactRead(orphan), Buffer.from("old orphan"));
  } finally {
    store.close();
  }
});

test("confirmed retention settles interruption after unlink and protects newly referenced remaining files", () => {
  const store = new Store(
    mkdtempSync(join(tmpdir(), "cur-retention-restart-")),
  );
  try {
    const ids = [
      store.artifact("orphan first"),
      store.artifact("orphan second"),
    ];
    const old = new Date(Date.now() - 3 * 86400000);
    ids.forEach((id) =>
      utimesSync(join(store.root, "artifacts", id), old, old),
    );
    const plan = previewRetention(store, Date.now() - 2 * 86400000);
    const first = plan.delete[0].artifact,
      second = plan.delete[1].artifact;
    store.put("retention-intents", plan.id, {
      digest: plan.digest,
      approvedAt: Date.now(),
      removed: [],
      pending: first,
    });
    unlinkSync(join(store.root, "artifacts", first));
    store.put("new-reference", "remaining", { image: second });
    assert.throws(
      () => applyRetention(store, plan, plan.digest),
      /references changed/,
    );
    assert.equal(existsSync(join(store.root, "artifacts", second)), true);
    store.db.prepare("DELETE FROM kv WHERE namespace='new-reference'").run();
    assert.deepEqual(applyRetention(store, plan, plan.digest).removed, [
      first,
      second,
    ]);
    assert.deepEqual(applyRetention(store, plan, plan.digest).removed, [
      first,
      second,
    ]);
  } finally {
    store.close();
  }
});

test("dataset export defaults to private text and image redaction, retains quarantine", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-redaction-"))),
    destination = new Store(
      mkdtempSync(join(tmpdir(), "cur-redacted-import-")),
    );
  try {
    const image = store.artifact("PRIVATE SCREENSHOT"),
      task = structuredTask(
        "private goal with Bearer SECRET",
        {
          host: "PRIVATE_HUMAN_HOSTNAME",
          session: "PRIVATE_SESSION",
          identity: "PRIVATE_TARGET",
        },
        { name: "password=PRIVATE", PRIVATE_FILENAME: "value" },
      );
    const observation = {
      schemaVersion: 1,
      id: "o",
      host: "PRIVATE_HUMAN_HOSTNAME",
      session: "PRIVATE_SESSION",
      target: "PRIVATE_TARGET",
      at: Date.now(),
      revision: "PRIVATE_REVISION",
      frame: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
      focused: true,
      facts: { text: "PRIVATE DOC", PRIVATE_PATIENT_NAME: true },
      image,
      features: [],
      backend: "test",
      desktop: { platform: "PRIVATE_PLATFORM", windows: [], apps: [] },
    };
    store.put("demonstrations", "demo", {
      id: "demo",
      PRIVATE_EXTRA: "PRIVATE_EXTRA_VALUE",
      session: "run",
      contract: { ...task, expected: { PRIVATE_MEDICAL_FACT: true } },
      verified: true,
      corrections: [],
      steps: [
        {
          PRIVATE_STEP_METADATA: "PRIVATE_EXTRA_VALUE",
          guard: "PRIVATE_GUARD_NAME",
          verify: "PRIVATE_VERIFY_NAME",
          before: observation,
          after: observation,
          action: {
            schemaVersion: 1,
            id: "a",
            runId: "run",
            requester: "user",
            host: observation.host,
            session: observation.session,
            target: observation.target,
            observationId: "o",
            revision: "PRIVATE_REVISION",
            frame: observation.frame,
            operation: "PRIVATE_OPERATION",
            args: { text: "PRIVATE DOC" },
            deadline: Date.now() + 5000,
            scope: "edit",
            generation: 1,
          },
          receipt: {
            schemaVersion: 1,
            actionId: "a",
            runId: "run",
            backend: "test",
            phase: "acknowledged",
            at: Date.now(),
            detail: "PRIVATE",
            timings: { PRIVATE_TIMING: 1 },
          },
          label: "verified",
        },
      ],
    });
    const bundle = exportDataset(store);
    assert.equal(bundle.privacy?.mode, "redacted");
    assert.equal(JSON.stringify(bundle).includes("PRIVATE"), false);
    const exported = bundle.demonstrations[0];
    assert.equal(exported.steps[0].before.host, exported.contract.target.host);
    assert.equal(exported.steps[0].after.host, exported.contract.target.host);
    assert.equal(
      exported.steps[0].action.target,
      exported.contract.target.identity,
    );
    assert.equal(
      exported.steps[0].action.observationId,
      exported.steps[0].before.id,
    );
    assert.equal(Object.keys(bundle.artifacts).includes(image), false);
    assert.equal(
      exported.steps[0].action.revision,
      exported.steps[0].before.revision,
    );
    assert.equal(importDataset(destination, bundle).status, "quarantined");
    assert.equal(
      exportDataset(store, { unredacted: true }).artifacts[image],
      Buffer.from("PRIVATE SCREENSHOT").toString("base64"),
    );
  } finally {
    destination.close();
    store.close();
  }
});
