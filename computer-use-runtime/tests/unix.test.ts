import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { Observation } from "../src/contracts/index.js";
import { actionStep } from "../src/assistant/planner.js";
import { supportedWindow } from "../src/adapters/desktop.js";
const observation: Observation = {
  schemaVersion: 1,
  id: "o",
  host: "test",
  session: "test",
  target: "1",
  at: Date.now(),
  revision: "r",
  frame: { x: 0, y: 0, width: 100, height: 100, scale: 1 },
  focused: true,
  facts: {
    desktopPlatform: "macOS",
    supportedOperations: '["key","fill"]',
    supportedKeys: '["Meta+N","Meta+S"]',
  },
  controls: [],
  features: [],
  backend: "unit-test",
};
test("platform action planning uses macOS Command shortcuts and advertised operations", () => {
  assert.equal(
    actionStep(
      { kind: "action", summary: "Save", operation: "key", key: "Meta+S" },
      observation,
      false,
    ).scope,
    "save",
  );
  assert.throws(
    () =>
      actionStep(
        { kind: "action", summary: "New", operation: "key", key: "Control+N" },
        observation,
        false,
      ),
    /OS session/,
  );
  assert.throws(
    () =>
      actionStep(
        { kind: "action", summary: "Click", operation: "click", x: 1, y: 1 },
        observation,
        true,
      ),
    /session does not support/,
  );
  assert.throws(
    () =>
      actionStep(
        { kind: "action", summary: "New", operation: "key", key: "Meta+N" },
        { ...observation, facts: { desktopPlatform: "Linux" } },
        false,
      ),
    /macOS/,
  );
});
test("macOS and Linux terminal and credential apps stay out of the supported window list", () => {
  for (const exe of [
    "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal",
    "/usr/bin/gnome-terminal-server",
    "/usr/bin/keepassxc",
    "/Applications/1Password.app/Contents/MacOS/1Password",
  ])
    assert.equal(supportedWindow({ executable: exe, title: "window" }), false);
  assert.equal(
    supportedWindow({ executable: "/usr/bin/mousepad", title: "Text" }),
    true,
  );
});
test("Unix worker protocol and macOS event argument regressions", () => {
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["tests/unix_worker_test.py"],
    { encoding: "utf8", windowsHide: true, timeout: 15000 },
  );
  assert.equal(
    result.status,
    0,
    result.error?.message || result.stdout + result.stderr,
  );
});
