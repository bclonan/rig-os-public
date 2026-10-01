import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { JsonExperienceStore } from "../examples/ports/json-experience.js";
import { JsonSkillRepository } from "../examples/ports/json-skills.js";
import { Runtime } from "../src/runtime/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Store } from "../src/storage/index.js";
import { Registry, seedForm, seal } from "../src/skills/index.js";
import { structuredTask } from "../src/compiler/intent.js";
import type { Action, Receipt } from "../src/contracts/index.js";

function requireExplicitCustomRepository(
  store: JsonExperienceStore,
  adapter: BrowserAdapter,
) {
  // @ts-expect-error A custom repository type cannot omit its injected instance.
  new Runtime<JsonExperienceStore, JsonSkillRepository>(store, adapter);
}
void requireExplicitCustomRepository;

test("JSON and SQLite ports roll back thrown and asynchronous transactions", () => {
  for (const Backend of [JsonExperienceStore, Store]) {
    const root = mkdtempSync(join(tmpdir(), "cur-port-transactions-"));
    const store = new Backend(root);
    try {
      assert.throws(
        () =>
          store.transaction(() => {
            store.put("test", "discard", 1);
            store.remember("discard", { input: 1 }, "run");
            store.append("run", "discard", {}, "correlation");
            throw new Error("intentional rollback");
          }),
        /intentional rollback/,
      );
      assert.equal(store.get("test", "discard"), undefined);
      assert.equal(store.dedup("discard", { input: 1 }), undefined);
      assert.equal(store.events().length, 0);
      assert.throws(
        () =>
          store.transaction(async () => {
            store.put("test", "async", 1);
          }),
        /Asynchronous transaction/,
      );
      assert.equal(store.get("test", "async"), undefined);
      store.transaction(() => store.put("test", "committed", { value: 7 }));
      const detached = store.get<{ value: number }>("test", "committed")!;
      detached.value = 99;
      assert.equal(store.get<{ value: number }>("test", "committed")!.value, 7);
    } finally {
      store.close();
    }
    const reopened = new Backend(root);
    try {
      assert.equal(reopened.get("test", "discard"), undefined);
      assert.equal(reopened.get("test", "async"), undefined);
      assert.equal(
        reopened.get<{ value: number }>("test", "committed")!.value,
        7,
      );
    } finally {
      reopened.close();
    }
  }
});

test("JSON port excludes another owner and validates persisted artifacts and skill versions", () => {
  const root = mkdtempSync(join(tmpdir(), "cur-port-storage-"));
  const store = new JsonExperienceStore(root);
  try {
    assert.throws(() => new JsonExperienceStore(root), /coordinator owns/);
    const repo = new JsonSkillRepository(join(root, "skills.json"));
    const first = seedForm();
    repo.put(first);
    first.description = "Mutated by caller after put";
    assert.notEqual(repo.get(first.id).description, first.description);
    first.description = repo.get(first.id).description;
    const second = seal({
      ...first,
      version: "2.0.0",
      description: "Second tested version",
    });
    repo.put(second);
    const reopened = new JsonSkillRepository(repo.path);
    assert.equal(reopened.get(first.id).hash, second.hash);
    assert.equal(reopened.version(first.hash).description, first.description);
    const detached = reopened.get(first.id);
    detached.description = "changed externally";
    assert.equal(reopened.get(first.id).description, second.description);
    const digest = store.artifact("owned artifact");
    assert.equal(store.artifactRead(digest).toString(), "owned artifact");
    assert.throws(() => store.artifactRead("../escape"), /Invalid artifact/);
    writeFileSync(join(root, "artifacts", digest), "corrupt");
    assert.throws(() => store.artifactRead(digest), /Corrupt artifact/);
    assert.throws(() => store.artifact("owned artifact"), /Corrupt artifact/);
    assert.equal(existsSync(join(root, "runtime.sqlite")), false);
    assert.equal(store instanceof Store, false);
    assert.equal(repo instanceof Registry, false);
  } finally {
    store.close();
  }
});

test(
  "actual Runtime accepts independent JSON ports, journals browser effects and reopens a pinned paused skill",
  { timeout: 45000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "cur-port-browser-"));
    let store = new JsonExperienceStore(root);
    let repository = new JsonSkillRepository(join(root, "skills.json"));
    let adapter = await new BrowserAdapter(store).start();
    let selections = 0;
    const selector = async (
      _task: unknown,
      _observation: unknown,
      repo: JsonSkillRepository,
    ) => {
      selections++;
      assert.equal(repo, repository);
      return repo.get("form.seed");
    };
    let runtime = new Runtime(
      store,
      adapter,
      undefined,
      undefined,
      selector,
      undefined,
      repository,
    );
    const base = seedForm();
    repository.put(base);
    try {
      assert.equal(runtime.registry, repository);
      const target = {
        host: adapter.host,
        session: adapter.session,
        identity: adapter.identity,
      };
      const selected = structuredTask("Apply JSON port selection", target, {
        name: "JSON Alder",
      });
      selected.method = "auto";
      const accepted = runtime.submit(selected, "select-json");
      assert.equal(runtime.submit(selected, "select-json").id, accepted.id);
      assert.throws(
        () =>
          runtime.submit(
            { ...selected, goal: "Changed request" },
            "select-json",
          ),
        /different request/,
      );
      await runtime.execute(accepted.id);
      assert.equal(
        store.run(accepted.id).status,
        "succeeded",
        store.run(accepted.id).error || "",
      );
      assert.equal(
        await adapter.page.locator("#result").textContent(),
        "JSON Alder",
      );
      assert.equal(selections, 1);
      const events = store.events(0, accepted.id);
      const requested = events.filter((event) => event.type === "requested");
      assert.equal(requested.length, 2);
      for (const entry of requested) {
        const action = entry.data as Action;
        const receipt = events.find(
          (event) =>
            event.type === "acknowledged" &&
            (event.data as Receipt).actionId === action.id,
        )!.data as Receipt;
        assert.equal(receipt.runId, accepted.id);
        assert.equal(receipt.phase, "acknowledged");
      }
      const images = events
        .map(
          (entry) =>
            (entry.data as { observation?: { image?: string } }).observation
              ?.image,
        )
        .filter((value): value is string => Boolean(value));
      assert.ok(
        images.length >= 3,
        "Actual observations and their image artifacts must persist",
      );
      for (const image of images)
        assert.equal(
          store.artifactRead(image).subarray(1, 4).toString(),
          "PNG",
        );
      const pausedSkill = seal({
        ...base,
        id: "json.paused",
        budgets: { steps: 8, retries: 0 },
        machine: {
          initial: "work",
          states: [
            {
              id: "work",
              monitor: [],
              steps: [
                {
                  id: "wait",
                  operation: "wait",
                  args: {},
                  waitMs: 1500,
                  scope: "edit",
                },
                ...base.machine.states.flatMap((state) => state.steps),
              ],
            },
          ],
        },
      });
      repository.put(pausedSkill);
      const task = structuredTask(
        "Resume the original JSON skill",
        target,
        { name: "Pinned Birch" },
        pausedSkill.id,
      );
      runtime.submit(task, task.id);
      const execution = runtime.execute(task.id);
      const until = Date.now() + 5000;
      while (
        !store.events(0, task.id).some((event) => event.type === "waiting")
      ) {
        assert.ok(Date.now() < until, "Actual wait must begin before pause");
        await delay(10);
      }
      await runtime.control(task.id, "pause");
      await execution;
      assert.equal(store.run(task.id).status, "paused");
      assert.equal(store.run(task.id).bindings.skillHash, pausedSkill.hash);
      const replacement = structuredClone(pausedSkill);
      replacement.version = "2.0.0";
      replacement.machine.states[0].steps.find(
        (step) => step.operation === "fill",
      )!.args.value = "Wrong newer version";
      repository.put(seal(replacement));
      const lastSequence = store.events().at(-1)!.seq;
      const evidenceBytes = readFileSync(join(root, "experience.json"));
      assert.ok(evidenceBytes.includes(Buffer.from(task.id)));
      await runtime.close();
      store = new JsonExperienceStore(root);
      repository = new JsonSkillRepository(join(root, "skills.json"));
      adapter = await new BrowserAdapter(store).start();
      runtime = new Runtime(
        store,
        adapter,
        undefined,
        undefined,
        selector,
        undefined,
        repository,
      );
      assert.equal(store.run(task.id).status, "paused");
      assert.notEqual(repository.get(pausedSkill.id).hash, pausedSkill.hash);
      assert.equal(repository.version(pausedSkill.hash).hash, pausedSkill.hash);
      await runtime.control(task.id, "resume");
      await runtime.execute(task.id);
      assert.equal(
        store.run(task.id).status,
        "succeeded",
        store.run(task.id).error || "",
      );
      assert.equal(store.run(task.id).bindings.skillHash, pausedSkill.hash);
      assert.equal(
        await adapter.page.locator("#result").textContent(),
        "Pinned Birch",
      );
      assert.ok(
        store
          .events(lastSequence, task.id)
          .some((event) => event.type === "completed"),
      );
      assert.equal(store.dedup("select-json", selected), accepted.id);
      assert.equal(existsSync(join(root, "runtime.sqlite")), false);
    } finally {
      await runtime.close();
    }
  },
);

test("default Registry uses the experience port without concrete Store", async () => {
  const store = new JsonExperienceStore(
    mkdtempSync(join(tmpdir(), "cur-port-default-")),
  );
  const adapter = await new BrowserAdapter(store).start();
  const runtime = new Runtime(store, adapter);
  try {
    runtime.registry.put(seedForm());
    const task = structuredTask(
      "Default repository on JSON",
      {
        host: adapter.host,
        session: adapter.session,
        identity: adapter.identity,
      },
      { name: "Default Cedar" },
    );
    runtime.submit(task, task.id);
    await runtime.execute(task.id);
    assert.equal(
      store.run(task.id).status,
      "succeeded",
      store.run(task.id).error || "",
    );
    assert.equal(
      await adapter.page.locator("#result").textContent(),
      "Default Cedar",
    );
  } finally {
    await runtime.close();
  }
});
