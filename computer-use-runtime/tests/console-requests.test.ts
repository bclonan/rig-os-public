import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parse, compileScript } from "@vue/compiler-sfc";
import ts from "typescript";
import * as vue from "vue";
import { RuntimeClient } from "../src/sdk/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

// Execute the real SFC setup and real Vue watchers. DOM and lifecycle registration
// are controlled here; browser integration is measured separately.
function setup(
  name: string,
  props: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
) {
  const script = compileScript(
    parse(readFileSync(`console/${name}.vue`, "utf8")).descriptor,
    { id: "request-regression" },
  ).content;
  const compiled = ts.transpileModule(script, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2023,
    },
  }).outputText;
  const unmount: (() => void)[] = [],
    downloads: string[] = [];
  const module = { exports: {} as any };
  const require = createRequire(import.meta.url);
  const load = (id: string) =>
    id === "vue"
      ? {
          ...vue,
          onMounted() {},
          onUnmounted(fn: () => void) {
            unmount.push(fn);
          },
        }
      : id.includes("sdk/index")
        ? { RuntimeClient }
        : id.endsWith(".vue")
          ? {}
          : require(id);
  const scope = vue.effectScope();
  const document = {
    getElementById: () => null,
    createElement: () => ({
      href: "",
      download: "",
      click() {
        downloads.push(this.download);
      },
    }),
  };
  new Function(
    "require",
    "module",
    "exports",
    "window",
    "location",
    "sessionStorage",
    "document",
    "fetch",
    compiled,
  )(
    load,
    module,
    module.exports,
    { addEventListener() {}, removeEventListener() {} },
    { hash: "" },
    { getItem: () => null },
    document,
    fetcher,
  );
  const reactiveProps = vue.reactive(props);
  const api = scope.run(() =>
    module.exports.default.setup(reactiveProps, { expose() {}, emit() {} }),
  );
  return {
    api,
    props: reactiveProps,
    downloads,
    dispose() {
      for (const fn of unmount) fn();
      scope.stop();
    },
  };
}

test("App advice ignores an old A response after A to B to A selection", async () => {
  const old = deferred<any>(),
    fresh = deferred<any>();
  const h = setup("App", {});
  let calls = 0;
  h.api.client = {
    request: async () => [],
    advice: () => (++calls === 1 ? old.promise : fresh.promise),
  };
  try {
    h.api.selected.value = "A";
    await vue.nextTick();
    const pending = h.api.assessOwnedState();
    h.api.selected.value = "B";
    await vue.nextTick();
    h.api.selected.value = "A";
    await vue.nextTick();
    const next = h.api.assessOwnedState();
    fresh.resolve({ task: "A", fresh: true });
    await next;
    old.resolve({ task: "A", fresh: false });
    await pending;
    assert.deepEqual(h.api.advice.value, { task: "A", fresh: true });
  } finally {
    h.dispose();
  }
});

test("App replay ignores late images from an earlier task or request", async () => {
  const old = deferred<Response>(),
    fresh = deferred<Response>();
  let calls = 0;
  const h = setup("App", {}, (() =>
    ++calls === 1 ? old.promise : fresh.promise) as typeof fetch);
  try {
    h.api.selected.value = "A";
    const first = h.api.replay("image/old");
    h.api.selected.value = "B";
    const second = h.api.replay("image/new");
    fresh.resolve(new Response("new"));
    await second;
    const image = h.api.image.value;
    assert.ok(image.startsWith("blob:"));
    old.resolve(new Response("old"));
    await first;
    assert.equal(h.api.image.value, image);
  } finally {
    h.dispose();
  }
});

test("Artifact details ignore late responses and encode opaque task IDs", async () => {
  const old = deferred<any>(),
    fresh = deferred<any>();
  const paths: string[] = [];
  const client = {
    request: async (path: string) => {
      paths.push(path);
      if (path === "/api/tasks") return [];
      return path.endsWith("A%2F%3F") ? old.promise : fresh.promise;
    },
  };
  const h = setup("ArtifactWorkspace", { client, caps: {} });
  try {
    h.api.selected.value = "A/?";
    const first = h.api.refresh();
    await Promise.resolve();
    h.api.selected.value = "B";
    const second = h.api.refresh();
    await Promise.resolve();
    fresh.resolve({ run: { id: "B" } });
    await second;
    old.resolve({ run: { id: "A/?" } });
    await first;
    assert.equal(h.api.detail.value.run.id, "B");
    assert.ok(paths.includes("/api/artifact-tasks/A%2F%3F"));
  } finally {
    h.dispose();
  }
});

test("Artifact downloads refuse stale task content and keep the captured filename format", async () => {
  const old = deferred<any>(),
    fresh = deferred<any>();
  let calls = 0;
  const h = setup("ArtifactWorkspace", {
    client: {
      artifactOutput: () => (++calls === 1 ? old.promise : fresh.promise),
    },
    caps: {},
  });
  try {
    h.api.selected.value = "A";
    h.api.detail.value = { spec: { kind: "csv_transform" } };
    const first = h.api.output(true);
    h.api.selected.value = "B";
    h.api.detail.value = { spec: { kind: "json_projection" } };
    old.resolve({ content: "old CSV" });
    await first;
    assert.equal(h.api.preview.value, "");
    assert.deepEqual(h.downloads, []);
    const second = h.api.output(true);
    fresh.resolve({ content: '[{"new":true}]' });
    await second;
    assert.equal(h.api.preview.value, '[{"new":true}]');
    assert.deepEqual(h.downloads, ["result.json"]);
  } finally {
    h.dispose();
  }
});

test("Artifact stale errors and unmounted downloads cannot alter the workspace", async () => {
  const old = deferred<any>(),
    later = deferred<any>();
  let calls = 0;
  const h = setup("ArtifactWorkspace", {
    client: {
      artifactOutput: () => (++calls === 1 ? old.promise : later.promise),
    },
    caps: {},
  });
  h.api.selected.value = "A";
  const first = h.api.output(true);
  h.api.selected.value = "B";
  old.reject(new Error("old failure"));
  await first;
  assert.equal(h.api.error.value, "");
  const second = h.api.output(true);
  h.dispose();
  later.resolve({ content: "after unmount" });
  await second;
  assert.equal(h.api.preview.value, "");
  assert.deepEqual(h.downloads, []);
});

test("Desktop canvas assessment remains bound to task, subject and client", async () => {
  const held = deferred<any>();
  const paths: string[] = [];
  const client = {
    request: async (path: string) => {
      paths.push(path);
      return path.endsWith("/assess") ? held.promise : {};
    },
  };
  const h = setup("DesktopWorkspace", {
    client,
    runs: [],
    providers: {},
    token: "public-test",
  });
  try {
    h.api.selected.value = "A/?";
    await vue.nextTick();
    h.api.subject.value = "dog";
    const pending = h.api.assessCanvas();
    h.api.subject.value = "cat";
    held.resolve({ assessment: { subject: "dog" } });
    await pending;
    assert.equal(h.api.semantic.value, undefined);
    assert.ok(paths.includes("/api/desktop/tasks/A%2F%3F/assess"));
  } finally {
    h.dispose();
  }
});
