import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Store } from "../src/storage/index.js";
import { BrowserAdapter } from "../src/adapters/browser.js";
import { Runtime } from "../src/runtime/index.js";
import { service } from "../src/service/index.js";
import { seal, seedForm } from "../src/skills/index.js";
import { OllamaProvider } from "../src/providers/index.js";

test(
  "served Vue Test encodes imported IDs; delayed artifact download cannot cross task selection",
  { timeout: 30000 },
  async () => {
    const store = new Store(
      mkdtempSync(join(tmpdir(), "cur-console-security-")),
    );
    const adapter = new BrowserAdapter(store);
    let runtime: Runtime | undefined,
      app: Awaited<ReturnType<typeof service>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const discover = OllamaProvider.discover;
    OllamaProvider.discover = async () => ({ models: [] });
    const skillId = "../service/shutdown?";
    let tested = 0,
      release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    try {
      await adapter.start();
      runtime = new Runtime(store, adapter);
      runtime.registry.import(seal({ ...seedForm(), id: skillId }));
      runtime.testCandidate = async () => {
        tested++;
        throw new Error("Intended candidate route");
      };
      app = await service(runtime);
      const url = await app.listen({ host: "127.0.0.1", port: 0 });
      browser = await chromium.launch();
      const page = await browser.newPage({ acceptDownloads: true });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(url + "/#skills");
      await page
        .getByLabel("Local service token", { exact: true })
        .fill(store.token());
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      const candidate = page
        .locator("details")
        .filter({ has: page.locator("summary", { hasText: skillId }) });
      await candidate.locator("summary").click();
      const response = page.waitForResponse(
        (r) =>
          r.url().includes("/api/skills/") && r.request().method() === "POST",
      );
      await candidate
        .getByRole("button", {
          name: "Test candidate and publish if it passes",
          exact: true,
        })
        .click();
      const testedResponse = await response;
      assert.equal(
        new URL(testedResponse.url()).pathname,
        "/api/skills/..%2Fservice%2Fshutdown%3F/test",
      );
      await page
        .getByRole("alert")
        .filter({ hasText: "Intended candidate route" })
        .waitFor();
      assert.equal(tested, 1);
      assert.equal(
        (
          await app.inject({
            url: "/api/service",
            headers: {
              host: "127.0.0.1",
              authorization: "Bearer " + store.token(),
            },
          })
        ).json().status,
        "running",
      );
      assert.equal(store.runs().length, 0);

      // Controlled artifact responses test UI ownership, not artifact construction.
      const a = "artifact/A?",
        b = "artifact-B";
      const tasks = [a, b].map((id) => ({
        id,
        status: "succeeded",
        cursor: 0,
        bindings: {},
        contract: { method: "artifact.fixture", goal: id },
      }));
      await page.route("**/api/tasks", (route) =>
        route.fulfill({ json: tasks }),
      );
      let arrived!: () => void;
      const downloadArrived = new Promise<void>((r) => (arrived = r));
      await page.route("**/api/artifact-tasks/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        const id = decodeURIComponent(path.split("/")[3]);
        if (path.endsWith("/download")) {
          if (id === a) {
            arrived();
            await held;
          }
          await route.fulfill({
            body: id === a ? "old,csv" : '[{"new":true}]',
            contentType: id === a ? "text/csv" : "application/json",
          });
        } else
          await route.fulfill({
            json: {
              run: tasks.find((t) => t.id === id),
              spec: { kind: id === a ? "csv_transform" : "json_projection" },
              attempts: [],
              state: {},
            },
          });
      });
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "Artifacts", exact: true })
        .click();
      await page
        .getByRole("button", { name: a + " , succeeded", exact: true })
        .click();
      const completedOld = page.waitForResponse((r) =>
        r.url().includes(encodeURIComponent(a) + "/download"),
      );
      await page
        .getByRole("button", { name: "Download verified output", exact: true })
        .click();
      await downloadArrived;
      const downloads: string[] = [];
      page.on("download", (d) => downloads.push(d.suggestedFilename()));
      await page
        .getByRole("button", { name: b + " , succeeded", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Download verified output", exact: true })
        .waitFor();
      release();
      await (await completedOld).finished();
      await page.evaluate(
        () =>
          new Promise<void>((r) =>
            requestAnimationFrame(() => requestAnimationFrame(() => r())),
          ),
      );
      assert.equal(
        await page.locator("pre").filter({ hasText: "old,csv" }).count(),
        0,
      );
      assert.deepEqual(downloads, []);
      const downloaded = page.waitForEvent("download");
      await page
        .getByRole("button", { name: "Download verified output", exact: true })
        .click();
      assert.equal((await downloaded).suggestedFilename(), "result.json");
      await page.locator("pre").filter({ hasText: '[{"new":true}]' }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      release?.();
      OllamaProvider.discover = discover;
      const results = await Promise.allSettled([
        browser?.close(),
        app?.close(),
      ]);
      const failures = results.filter((r) => r.status === "rejected");
      if (!app)
        await (runtime?.close() ??
          adapter.close().finally(() => store.close()));
      if (failures.length)
        throw new AggregateError(
          failures.map((r) => (r as PromiseRejectedResult).reason),
          "Console regression cleanup failed",
        );
    }
  },
);
