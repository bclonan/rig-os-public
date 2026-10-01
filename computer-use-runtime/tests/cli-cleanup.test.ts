import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

for (const mode of [
  "startup",
  "recovery",
  "selector-close",
  "runtime-close",
  "combined",
]) {
  test(
    `offline CLI drains owned resources after ${mode} failure`,
    { timeout: 15000 },
    () => {
      const root = mkdtempSync(join(tmpdir(), "cur-cli-cleanup-"));
      const module = (path: string) =>
        JSON.stringify(pathToFileURL(resolve(path)).href);
      const code = `
      import { existsSync } from 'node:fs';
      import { join } from 'node:path';
      import { Store } from ${module("src/storage/index.ts")};
      import { BrowserAdapter } from ${module("src/adapters/browser.ts")};
      import { AdaptiveSelector } from ${module("src/learner/selector.ts")};
      import { Runtime } from ${module("src/runtime/index.ts")};
      const calls = [];
      const originalStoreClose = Store.prototype.close;
      Store.prototype.close = function(){ calls.push('store'); return originalStoreClose.call(this); };
      BrowserAdapter.prototype.start = async function(){ calls.push('start'); ${mode === "startup" || mode === "combined" ? "throw new Error('injected startup');" : "return this;"} };
      BrowserAdapter.prototype.close = async function(){ calls.push('adapter'); ${mode === "combined" ? "throw new Error('injected adapter close');" : ""} };
      AdaptiveSelector.prototype.close = async function(){ calls.push('selector'); ${mode === "selector-close" ? "throw new Error('injected selector close');" : ""} };
      ${mode === "recovery" ? "Runtime.prototype.recover = async function(){throw new Error('injected recovery');};" : ""}
      ${mode === "runtime-close" ? "Runtime.prototype.close = async function(){calls.push('runtime');throw new Error('injected runtime close');};" : ""}
      process.argv = [process.execPath, 'src/cli.ts', 'export', 'form.seed', ${JSON.stringify(join(root, "export.json"))}];
      await import(${module("src/cli.ts")});
      console.log('CLEANUP_RESULT '+JSON.stringify({calls, lock: existsSync(join(process.env.CUR_DATA,'coordinator.lock'))}));
    `;
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-"],
        {
          input: code,
          env: { ...process.env, CUR_DATA: root },
          encoding: "utf8",
          windowsHide: true,
          timeout: 12000,
        },
      );
      assert.equal(result.status, 1, result.stdout + result.stderr);
      const output = JSON.parse(result.stdout.split("CLEANUP_RESULT ")[1]);
      assert.equal(output.lock, false, result.stdout + result.stderr);
      assert.ok(output.calls.includes("adapter"));
      assert.ok(output.calls.includes("store"));
      if (mode === "selector-close")
        assert.match(result.stderr, /injected selector close/);
      if (mode === "combined") {
        assert.match(result.stderr, /injected startup/);
        assert.match(result.stderr, /injected adapter close/);
      }
    },
  );
}
