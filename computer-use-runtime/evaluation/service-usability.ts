import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const root = join(
  mkdtempSync(join(tmpdir(), "cur-console-lifecycle-")),
  "store",
);
const portFinder = createServer();
await new Promise<void>((resolve) =>
  portFinder.listen(0, "127.0.0.1", resolve),
);
const port = (portFinder.address() as any).port;
await new Promise<void>((resolve) => portFinder.close(() => resolve()));
const url = `http://127.0.0.1:${port}`;
const children: ReturnType<typeof launch>[] = [];
function launch() {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "start"],
    {
      env: { ...process.env, CUR_DATA: root, CUR_PORT: String(port) },
      windowsHide: true,
    },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    output += data;
  });
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { child, finished, output: () => output };
}
async function start() {
  const run = launch();
  children.push(run);
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (run.output().includes("runtime is ready")) return run;
    if (run.child.exitCode !== null) throw new Error("Service startup failed");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Service startup timed out");
}
const browser = await chromium.launch();
const page = await browser.newPage();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(String(error)));
const report: any = {
  status: "NOT RUN",
  platform: process.platform,
  at: new Date().toISOString(),
  level: "real CLI subprocesses and live browser console",
  checks: [],
};
try {
  const first = await start();
  const token = readFileSync(join(root, "service.token"), "utf8");
  await page.goto(url);
  await page.getByLabel("Local service token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Show token", exact: true }).click();
  assert.equal(
    await page.getByLabel("Local service token").getAttribute("type"),
    "text",
  );
  await page.getByRole("button", { name: "Hide token", exact: true }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("heading", { name: "Desktop assistant" }).waitFor();
  report.checks.push("token reveal/hide and authenticated login");
  await page.reload();
  assert.equal(
    await page.getByLabel("Local service token").inputValue(),
    token,
  );
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.getByRole("heading", { name: "Desktop assistant" }).waitFor();
  report.checks.push("tab-scoped token survives reload");
  await page
    .getByRole("button", { name: "Shut down runtime", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Shutdown requested" })
    .waitFor();
  assert.equal(await first.finished, 0);
  assert.ok(!existsSync(join(root, "coordinator.lock")));
  report.checks.push(
    "console shutdown exits the process and releases the store",
  );
  const second = await start();
  assert.equal(readFileSync(join(root, "service.token"), "utf8"), token);
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.getByRole("heading", { name: "Desktop assistant" }).waitFor();
  await page.getByRole("button", { name: "Runs", exact: true }).click();
  await page
    .getByLabel("Display name", { exact: true })
    .fill("Usability Cedar");
  await page.getByRole("button", { name: "Run task", exact: true }).click();
  await page
    .locator("button.run small")
    .filter({ hasText: "succeeded" })
    .waitFor();
  report.checks.push("same-token reconnect and task execution after restart");
  second.child.stdin.write("stop\n");
  assert.equal(await second.finished, 0);
  await page
    .getByRole("status")
    .filter({ hasText: "Connection lost" })
    .waitFor({ timeout: 8000 });
  report.checks.push("external stop produces a reconnect screen");
  const third = await start();
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await page.getByRole("heading", { name: "Desktop assistant" }).waitFor();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  assert.equal(await page.getByLabel("Local service token").inputValue(), "");
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem("runtime-token")),
    null,
  );
  report.checks.push("disconnect clears the saved credential");
  third.child.stdin.write("stop\n");
  assert.equal(await third.finished, 0);
  assert.deepEqual(errors, []);
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  report.reason = String(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  for (const run of children) {
    if (run.child.exitCode === null) run.child.stdin.write("stop\n");
    const timer = setTimeout(() => run.child.kill(), 5000);
    await run.finished.catch(() => {});
    clearTimeout(timer);
  }
  report.errors = errors;
  writeFileSync(
    process.platform === "linux"
      ? "evidence/linux-service-usability.json"
      : "evidence/service-usability.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
}
