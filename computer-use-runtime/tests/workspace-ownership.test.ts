import { test } from "node:test";
import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Store, hash } from "../src/storage/index.js";
import { PermissionedTools, type ToolRequest } from "../src/tools/index.js";
import { withWorkspaceLease } from "../src/tools/workspace-lease.js";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "cur-exclusive-workspace-"));
  const root = join(base, "workspace");
  mkdirSync(root);
  const store = new Store(join(base, "store"));
  const tools = new PermissionedTools(store, {
    root,
    exclusiveRoot: true,
    allowedOrigins: [],
    permissions: ["workspace_read", "workspace_write"],
  });
  return { base, root, store, tools };
}
function request(
  operation: ToolRequest["operation"],
  args: ToolRequest["args"],
): ToolRequest {
  return {
    id: randomUUID(),
    runId: "owned-workspace",
    correlationId: randomUUID(),
    requester: "test",
    operation,
    args,
    deadline: Date.now() + 5000,
  };
}

test("workspace permission requires explicit exclusive ownership and protects its lease", async () => {
  const { root, store, tools } = fixture();
  try {
    assert.throws(
      () =>
        new PermissionedTools(store, {
          root,
          allowedOrigins: [],
          permissions: ["workspace_read"],
        }),
      /exclusiveRoot/,
    );
    await assert.rejects(
      tools.execute(
        request("workspace_write", {
          path: ".cur-workspace.lock",
          content: "overwrite ownership",
        }),
      ),
      /protected/,
    );
    writeFileSync(join(root, ".cur-workspace.lock"), "another owner");
    await assert.rejects(
      tools.execute(
        request("workspace_write", {
          path: "result.txt",
          content: "must not write",
        }),
      ),
      /owned by another operation/,
    );
    assert.equal(
      readFileSync(join(root, ".cur-workspace.lock"), "utf8"),
      "another owner",
    );
    assert.equal(existsSync(join(root, "result.txt")), false);
  } finally {
    store.close();
  }
});

test("two cooperating overwrites with the same expected hash preserve the winner", async () => {
  const { root, store, tools } = fixture();
  const secondStore = new Store(join(root, "..", "second-store"));
  try {
    const other = new PermissionedTools(secondStore, tools.grant);
    writeFileSync(join(root, "result.txt"), "original");
    const results = await Promise.allSettled(
      [tools, other].map((tool, i) =>
        tool.execute(
          request("workspace_write", {
            path: "result.txt",
            content: "writer-" + i,
            expectedHash: hash("original"),
          }),
        ),
      ),
    );
    assert.equal(
      results.filter((value) => value.status === "fulfilled").length,
      1,
    );
    const loser = results.find((value) => value.status === "rejected");
    assert.ok(loser?.status === "rejected");
    assert.match(String(loser.reason), /expectedHash/);
    assert.equal(readFileSync(join(root, "result.txt"), "utf8"), "writer-0");
    assert.equal(existsSync(join(root, ".cur-workspace.lock")), false);
  } finally {
    secondStore.close();
    store.close();
  }
});

test("ABA directory replacement cannot return bytes from the wrong opened file", async () => {
  const { base, root, store, tools } = fixture();
  const directory = join(root, "inner"),
    saved = join(root, "saved"),
    outside = join(base, "outside");
  mkdirSync(directory);
  mkdirSync(outside);
  const target = join(directory, "file.txt");
  writeFileSync(target, "granted public file");
  writeFileSync(join(outside, "file.txt"), "OUTSIDE SECRET");
  const original = fsPromises.open;
  let staged = false;
  fsPromises.open = (async (path, flags, mode) => {
    if (String(path) !== target || staged) return original(path, flags, mode);
    staged = true;
    renameSync(directory, saved);
    symlinkSync(
      outside,
      directory,
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      return await original(path, flags, mode);
    } finally {
      unlinkSync(directory);
      renameSync(saved, directory);
    }
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      tools.execute(request("workspace_read", { path: "inner/file.txt" })),
      /opened file does not match|outside its grant/,
    );
    assert.equal(staged, true, "fault schedule must actually execute");
    assert.equal(readFileSync(target, "utf8"), "granted public file");
    assert.equal(
      readFileSync(join(outside, "file.txt"), "utf8"),
      "OUTSIDE SECRET",
    );
    assert.equal(
      store
        .events(0)
        .some((event) => JSON.stringify(event).includes("OUTSIDE SECRET")),
      false,
    );
  } finally {
    fsPromises.open = original;
    syncBuiltinESMExports();
    store.close();
  }
});

test("replacing the root invalidates the grant before reading or writing", async () => {
  const { root, store, tools } = fixture();
  try {
    renameSync(root, root + "-original");
    mkdirSync(root);
    writeFileSync(join(root, "file.txt"), "replacement root");
    await assert.rejects(
      tools.execute(request("workspace_read", { path: "file.txt" })),
      /root identity changed/,
    );
    assert.equal(existsSync(join(root, ".cur-workspace.lock")), false);
  } finally {
    store.close();
  }
});

test("queued cancellation performs no effect and cleanup refuses a replaced lease", async () => {
  const { root, store } = fixture();
  try {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = withWorkspaceLease(
      root,
      async () => {
        entered();
        await gate;
      },
      AbortSignal.timeout(5000),
    );
    await ready;
    let effects = 0;
    const cancellation = new AbortController();
    const queued = withWorkspaceLease(
      root,
      async () => {
        effects++;
      },
      cancellation.signal,
    );
    cancellation.abort(new Error("cancel queued"));
    await assert.rejects(queued, /cancel queued/);
    assert.equal(effects, 0);
    release();
    await first;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(effects, 0);
    await assert.rejects(
      withWorkspaceLease(
        root,
        async () => {
          writeFileSync(join(root, ".cur-workspace.lock"), "replacement owner");
        },
        AbortSignal.timeout(5000),
      ),
      /ownership cleanup refused/,
    );
    assert.equal(
      readFileSync(join(root, ".cur-workspace.lock"), "utf8"),
      "replacement owner",
    );
  } finally {
    store.close();
  }
});
