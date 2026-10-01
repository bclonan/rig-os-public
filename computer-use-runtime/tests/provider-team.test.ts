import test from "node:test";
import assert from "node:assert/strict";
import type { ModelProvider } from "../src/contracts/ports.js";
import { TeamProvider } from "../src/providers/team.js";
import {
  createSelectedProvider,
  validateProviderSelections,
} from "../src/providers/selection.js";
import { ProviderDiagnosticError } from "../src/providers/transport.js";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: { action: { type: "string" } },
  required: ["action"],
};
function client(
  value: unknown,
  options: {
    local?: boolean;
    reject?: string;
    delay?: number;
    calls?: string[];
    name?: string;
  } = {},
): ModelProvider {
  return {
    capabilities: {
      schemaVersion: 1,
      id: options.name ?? "fixture",
      modalities: ["text", "image"],
      structuredOutput: true,
      tools: false,
      cancellation: true,
      local: options.local ?? true,
      available: true,
      maxTokens: 400,
    },
    async generate(_prompt, _schema, signal) {
      options.calls?.push(options.name ?? "fixture");
      if (options.delay)
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, options.delay);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("cancelled"));
            },
            { once: true },
          );
        });
      if (options.reject) throw new Error(options.reject);
      return value;
    },
  };
}
function member(
  model: string,
  value: unknown,
  options: Parameters<typeof client>[1] = {},
) {
  return {
    provider: "fixture",
    model,
    client: client(value, { ...options, name: model }),
  };
}

test("fallback rejects malformed proposals and selects the next schema-valid model", async () => {
  const calls: string[] = [];
  const team = new TeamProvider([
    member("bad", { action: "launch", forbidden: "extra" }, { calls }),
    member("good", { action: "draw" }, { calls }),
    member("unused", { action: "stop" }, { calls }),
  ]);
  assert.deepEqual(await team.generate("draw a dog", schema), {
    action: "draw",
  });
  assert.deepEqual(calls, ["bad", "good"]);
  assert.deepEqual(
    team.lastCall?.members.map((entry) => entry.status),
    ["failed", "valid", "unused"],
  );
  assert.equal(team.lastCall?.selectedMember, 1);
});

test("ensemble starts models together, chooses canonical consensus, and records individual failures", async () => {
  const calls: string[] = [];
  const team = new TeamProvider(
    [
      member("one", { action: "draw" }, { delay: 60, calls }),
      member("two", { action: "draw" }, { delay: 60, calls }),
      member("three", { action: "erase" }, { delay: 60, calls }),
      member("failed", {}, { reject: "Bearer private-token", calls }),
    ],
    "ensemble",
  );
  const pending = team.generate("draw a dog", schema);
  assert.deepEqual(calls, ["one", "two", "three", "failed"]);
  assert.deepEqual(await pending, { action: "draw" });
  assert.equal(team.lastCall?.selectionMethod, "consensus");
  assert.equal(team.lastCall?.members[3]?.status, "failed");
  assert.ok(!JSON.stringify(team.lastCall).includes("private-token"));
});

test("a tied ensemble uses declared model order rather than completion order", async () => {
  const team = new TeamProvider(
    [
      member("first", { action: "draw" }, { delay: 40 }),
      member("second", { action: "erase" }),
    ],
    "ensemble",
  );
  assert.deepEqual(await team.generate("draw a dog", schema), {
    action: "draw",
  });
  assert.equal(team.lastCall?.selectionMethod, "priority-tie");
  assert.equal(team.lastCall?.selectedMember, 0);
});

test("cloud members advertise remote transport and a cancelled team cannot select a result", async () => {
  const team = new TeamProvider(
    [member("cloud", { action: "draw" }, { local: false, delay: 100 })],
    "ensemble",
  );
  assert.equal(team.capabilities.local, false);
  const controller = new AbortController();
  const pending = team.generate("draw", schema, controller.signal);
  controller.abort();
  await assert.rejects(pending);
  assert.equal(team.lastCall?.selectedMember, undefined);
});

test("selection rejects excessive, duplicate, unknown or injected model configuration", () => {
  for (const input of [
    [],
    Array.from({ length: 5 }, (_, index) => ({
      provider: "ollama",
      model: "m" + index,
    })),
    [{ provider: "shell", model: "x" }],
    [{ provider: "codex-cli", model: "--dangerous" }],
    [{ provider: "ollama", model: "x; powershell" }],
    [{ provider: "ollama", model: "x", executable: "evil.exe" }],
    [
      { provider: "ollama", model: "x" },
      { provider: "ollama", model: "x" },
    ],
  ])
    assert.throws(() => validateProviderSelections(input));
  assert.doesNotThrow(() =>
    validateProviderSelections([
      { provider: "ollama", model: "qwen3.6:latest" },
      { provider: "codex-cli", model: "gpt-6.1-sol" },
      { provider: "claude-cli", model: "sonnet" },
    ]),
  );
  assert.equal(
    createSelectedProvider([{ provider: "codex-cli", model: "gpt-6.1-sol" }])
      .capabilities.local,
    false,
  );
});

test("all provider failures remain failures with bounded redacted provenance", async () => {
  const team = new TeamProvider([
    member("a", null),
    member("b", {}, { reject: "secret private page content" }),
  ]);
  await assert.rejects(
    team.generate("draw", schema),
    /Every selected model failed/,
  );
  assert.ok(!JSON.stringify(team.lastCall).includes("private page"));
  assert.equal(team.lastCall?.members.length, 2);
});

test("ensemble adjudication selects an existing proposal without changing it", async () => {
  const first = client({ action: "erase" });
  let calls = 0;
  first.generate = async (prompt, requestedSchema) => {
    calls++;
    if (
      "properties" in requestedSchema &&
      JSON.stringify(requestedSchema).includes("candidate")
    ) {
      assert.ok(prompt.includes("draw a dog"));
      assert.ok(prompt.includes("EXISTING_CANDIDATES"));
      return { candidate: 1 };
    }
    return { action: "erase" };
  };
  const requested = { action: "draw" };
  const team = new TeamProvider(
    [
      { provider: "fixture", model: "judge", client: first },
      member("draw-model", requested),
    ],
    "ensemble",
  );
  assert.equal(await team.generate("draw a dog", schema), requested);
  assert.equal(calls, 2);
  assert.equal(team.lastCall?.selectionMethod, "adjudicated");
  assert.deepEqual(team.lastCall?.adjudicator, { member: 0, status: "valid" });
});

test("an adjudicator cannot invent a candidate or replace its action", async () => {
  for (const decision of [
    { candidate: 999 },
    { candidate: 1, action: "injected" },
    { candidate: "1" },
  ]) {
    const first = client({ action: "draw" });
    let calls = 0;
    first.generate = async () =>
      ++calls === 1 ? { action: "draw" } : decision;
    const team = new TeamProvider(
      [
        { provider: "fixture", model: "judge", client: first },
        member("other", { action: "erase" }),
      ],
      "ensemble",
    );
    assert.deepEqual(await team.generate("draw", schema), { action: "draw" });
    assert.equal(team.lastCall?.selectionMethod, "priority-tie");
    assert.equal(team.lastCall?.adjudicator?.status, "failed");
  }
});

test("team retains classified local HTTP recovery but rejects arbitrary diagnostic text", async () => {
  const unavailable = client({});
  unavailable.generate = async () => {
    throw new ProviderDiagnosticError(
      "vision-unavailable",
      400,
      "Ollama generation",
    );
  };
  const team = new TeamProvider([
    { provider: "ollama", model: "fixture", client: unavailable },
    member("next", { action: "draw" }),
  ]);
  await team.generate("draw", schema);
  assert.equal(team.lastCall?.members[0]?.category, "vision-unavailable");
  assert.equal(team.lastCall?.members[0]?.httpStatus, 400);
  assert.ok(
    team.lastCall?.members[0]?.reason?.includes("cannot read screenshots"),
  );
  const forged = new ProviderDiagnosticError(
    "request-rejected",
    400,
    "Bearer private-token C:\\PrivateFixture\\private",
  );
  assert.ok(!forged.message.includes("private-token"));
});

test("cancelling adjudication returns no candidate and keeps the trace accurate", async () => {
  const controller = new AbortController();
  const first = client({ action: "draw" });
  let calls = 0;
  first.generate = async () => {
    if (++calls === 1) return { action: "draw" };
    controller.abort();
    throw new Error("cancelled");
  };
  const team = new TeamProvider(
    [
      { provider: "fixture", model: "judge", client: first },
      member("other", { action: "erase" }),
    ],
    "ensemble",
  );
  await assert.rejects(team.generate("draw", schema, controller.signal));
  assert.equal(team.lastCall?.selectedMember, undefined);
  assert.equal(team.lastCall?.adjudicator?.status, "failed");
  assert.ok(
    team.lastCall?.adjudicator?.reason?.includes("no candidate returned"),
  );
});
