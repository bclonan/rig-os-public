import assert from "node:assert/strict";
import { test } from "node:test";
import {
  providerParameters,
  providerSettings,
  taskProviderSettings,
} from "../src/providers/settings.js";
import { artifactConfiguration } from "../src/service/artifacts.js";

test("external selection cannot inherit local consent and saved task parameters preserve explicit consent", () => {
  const providers = [
    { provider: "codex-cli", model: "gpt-5.5" },
    { provider: "ollama", model: "qwen3.6:latest" },
  ];
  assert.throws(
    () => providerSettings({ providers }),
    /Allow the selected external/,
  );
  assert.throws(
    () => providerSettings({ providers, allowRemote: "true" }),
    /consent/,
  );
  const settings = providerSettings({
    providers,
    strategy: "ensemble",
    allowRemote: true,
  });
  const parameters = providerParameters(settings);
  assert.ok(
    Object.values(parameters).every(
      (value) => typeof value === "string" || typeof value === "boolean",
    ),
  );
  assert.deepEqual(taskProviderSettings(parameters), settings);
  assert.throws(
    () => taskProviderSettings({ ...parameters, allowRemote: false }),
    /Allow the selected external/,
  );
});

test("provider requests reject command flags, duplicate models, malformed persistence and more than four calls", () => {
  for (const model of [
    "--dangerously-bypass-approvals-and-sandbox",
    "gpt-5.5\n--config",
    "x;echo",
    " x",
    "x y",
  ])
    assert.throws(() =>
      providerSettings({
        providers: [{ provider: "codex-cli", model }],
        allowRemote: true,
      }),
    );
  assert.throws(() =>
    providerSettings({
      providers: [{ provider: "ollama", model: "x", executable: "other.exe" }],
    }),
  );
  assert.throws(
    () =>
      providerSettings({
        providers: Array.from({ length: 5 }, (_, i) => ({
          provider: "ollama",
          model: "m" + i,
        })),
      }),
    /one to four/,
  );
  assert.throws(
    () =>
      providerSettings({
        providers: [
          { provider: "ollama", model: "x" },
          { provider: "ollama", model: "x" },
        ],
      }),
    /different/,
  );
  assert.throws(
    () => taskProviderSettings({ plannerProviders: "{" }),
    /Invalid saved/,
  );
  assert.throws(
    () => providerSettings({ model: "x", strategy: "unreviewed-auto" }),
    /fallback/,
  );
});

test("legacy Ollama settings remain local and arbitrary installed names stay available", () => {
  const settings = providerSettings({ model: "my-model:custom" });
  assert.deepEqual(settings.providers, [
    { provider: "ollama", model: "my-model:custom" },
  ]);
  assert.equal(settings.allowRemote, false);
  assert.equal(settings.strategy, "fallback");
});

test("artifact criteria refuse unconsented remote processing before accepting source input", () => {
  assert.throws(
    () =>
      artifactConfiguration({
        model: "",
        providers: [{ provider: "claude-cli", model: "default" }],
        spec: {},
      }),
    /Allow the selected external/,
  );
});
