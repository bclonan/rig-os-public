import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { EnvironmentAdapter } from "../src/contracts/ports.js";
import { Store } from "../src/storage/index.js";
import { DesktopRouter } from "../src/adapters/desktop.js";
import { ComputerAdapter } from "../src/adapters/computer.js";
import { Runtime } from "../src/runtime/index.js";
import { structuredTask } from "../src/compiler/intent.js";

const operations = ["release", "takeover", "returnControl", "close"] as const;

function ownedAdapter(
  name: string,
  calls: string[],
): EnvironmentAdapter & { setTarget(): Promise<void> } {
  const adapter: EnvironmentAdapter & { setTarget(): Promise<void> } = {
    host: "owned-host",
    session: name + "-session",
    identity: name,
    capabilities: [],
    observe: async () => {
      throw new Error("No observations are used in this cleanup test");
    },
    acquire: async () => {
      throw new Error("No leases are acquired in this cleanup test");
    },
    execute: async () => {
      throw new Error("No input is sent in this cleanup test");
    },
    setTarget: async () => {},
    release: async () => {
      calls.push(name + ".release");
    },
    takeover: async () => {
      calls.push(name + ".takeover");
    },
    returnControl: async () => {
      calls.push(name + ".returnControl");
    },
    close: async () => {
      calls.push(name + ".close");
    },
  };
  return adapter;
}

function fixture() {
  const store = new Store(mkdtempSync(join(tmpdir(), "cur-router-cleanup-")));
  const router = new DesktopRouter(store),
    calls: string[] = [];
  const native = ownedAdapter("native", calls);
  const workspace = ownedAdapter("workspace", calls);
  const otherWorkspace = ownedAdapter("other-workspace", calls);
  const browser = ownedAdapter("browser", calls);
  for (const operation of operations)
    Object.assign(router.browser, { [operation]: browser[operation] });
  Object.assign(router, {
    native,
    workspaces: new Map([
      ["owned-run", workspace],
      ["other-run", otherWorkspace],
    ]),
  });
  return { store, router, native, workspace, otherWorkspace, calls };
}

test("router attempts every owned cleanup after an earlier component fails", async (t) => {
  for (const operation of operations)
    await t.test(operation, async () => {
      const { store, router, native, workspace, calls } = fixture();
      const failure = new Error("Owned workspace cleanup failed");
      workspace[operation] = async () => {
        calls.push("workspace." + operation);
        throw failure;
      };
      try {
        await assert.rejects(
          () => router[operation]("owned-run"),
          (error) => error === failure,
        );
        assert.deepEqual(
          [...calls].sort(),
          ["workspace", "other-workspace", "browser", "native"]
            .map((name) => name + "." + operation)
            .sort(),
        );
        assert.ok(calls.includes("native." + operation));
        assert.equal(native.session, "native-session");
      } finally {
        store.close();
      }
    });
});

test("router retains all failures and waits for slower cleanup to settle", async (t) => {
  for (const operation of operations)
    await t.test(operation, async () => {
      const { store, router, native, workspace, otherWorkspace, calls } =
        fixture();
      const early = new Error("Early workspace failure"),
        browserFailure = new Error("Browser failure"),
        delayed = new Error("Delayed native failure");
      workspace[operation] = () => {
        calls.push("workspace." + operation);
        throw early;
      };
      router.browser[operation] = async () => {
        calls.push("browser." + operation);
        throw browserFailure;
      };
      native[operation] = async () => {
        await delay(10);
        calls.push("native." + operation);
        throw delayed;
      };
      let settled = false;
      otherWorkspace[operation] = async () => {
        await delay(30);
        calls.push("other-workspace." + operation);
        settled = true;
      };
      try {
        await assert.rejects(
          () => router[operation]("owned-run"),
          (error) => {
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors, [early, browserFailure, delayed]);
            assert.equal(error.cause, early);
            assert.equal(settled, true);
            return true;
          },
        );
        assert.equal(calls.length, 4);
      } finally {
        store.close();
      }
    });
});

test("router cleanup uses the computer wrapper without closing its shared native worker twice", async () => {
  const { store, router, native, calls } = fixture();
  Object.assign(router, {
    computer: new ComputerAdapter(store, native, {
      windows: async () => [],
      apps: () => [],
      launch: async () => {},
    }),
  });
  try {
    await router.close();
    assert.equal(calls.filter((call) => call === "native.close").length, 1);
    assert.equal(calls.length, 4);
  } finally {
    store.close();
  }
});

test("partial router Return cleans all components but preserves every Runtime quarantine until full acknowledgement", async () => {
  const { store, router, native, calls } = fixture();
  const runtime = new Runtime(store, router);
  const targets = [router.browser, native];
  const tasks = targets.map((adapter) =>
    structuredTask(
      "Retain interrupted cleanup",
      {
        host: adapter.host,
        session: adapter.session,
        identity: adapter.identity,
      },
      { name: "Never dispatch" },
    ),
  );
  for (const task of tasks) {
    const run = runtime.submit(task, task.id);
    run.status = "reconciliation_required";
    run.bindings.cleanupFailed = true;
    store.putRun(run);
  }
  const browserReturn = router.browser.returnControl;
  router.browser.returnControl = async () => {
    calls.push("browser.returnControl");
    throw new Error("Browser Return failed");
  };
  try {
    await assert.rejects(
      () => runtime.returnControl(),
      /Browser Return failed/,
    );
    assert.equal(calls.length, 4);
    for (const task of tasks) {
      assert.equal(store.run(task.id).bindings.cleanupFailed, true);
      assert.equal(
        store
          .events(0, task.id)
          .some((event) => event.type === "human_return_acknowledged"),
        false,
      );
    }
    router.browser.returnControl = browserReturn;
    await runtime.returnControl();
    for (const task of tasks) {
      assert.equal(store.run(task.id).bindings.cleanupFailed, undefined);
      assert.equal(store.run(task.id).status, "reconciliation_required");
    }
  } finally {
    router.browser.returnControl = browserReturn;
    await runtime.close();
  }
});
