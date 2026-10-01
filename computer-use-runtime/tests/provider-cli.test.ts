import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cliArguments,
  codexOutputSchema,
  decodeCodexAnswer,
  codexProposalCatalog,
  requireClaudeApiKey,
  assertClaudePolicyIsUnmanaged,
  runCliProcess,
  validateCliAnswer,
  validModelName,
} from "../src/providers/cli.js";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: { action: { type: "string" } },
  required: ["action"],
};

async function fixture(
  code: string,
  operation: (directory: string, file: string) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "rig-cli-test-"));
  const file = path.join(directory, "fixture.cjs");
  await writeFile(file, code);
  try {
    await operation(directory, file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("real subprocess treats injected prompt as stdin data and uses no shell", async () => {
  await fixture(
    "let s='';process.stdin.on('data',v=>s+=v);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({input:s,args:process.argv.slice(2)})));",
    async (cwd, file) => {
      const input = "draw a dog\n$(echo secret) & whoami; --dangerous";
      const result = await runCliProcess(
        process.execPath,
        [file, "--fixed-value"],
        { cwd, input, timeoutMs: 5000 },
      );
      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        input,
        args: ["--fixed-value"],
      });
    },
  );
});

test("real subprocess output overflow stops the owned process", async () => {
  await fixture(
    "setInterval(()=>process.stdout.write('x'.repeat(8192)),1)",
    async (cwd, file) => {
      await assert.rejects(
        runCliProcess(process.execPath, [file], {
          cwd,
          timeoutMs: 5000,
          maxBytes: 1024,
        }),
        /byte budget/,
      );
    },
  );
});

test("real subprocess timeout terminates the owned child tree", async () => {
  await fixture(
    "const fs=require('fs'),{spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('child.pid',String(child.pid));setInterval(()=>{},1000);",
    async (cwd, file) => {
      await assert.rejects(
        runCliProcess(process.execPath, [file], { cwd, timeoutMs: 700 }),
        /timed out/,
      );
      const pid = Number(await readFile(path.join(cwd, "child.pid"), "utf8"));
      assert.throws(() => process.kill(pid, 0));
    },
  );
});

test("real subprocess abort terminates and reports cancellation", async () => {
  await fixture("setInterval(()=>{},1000)", async (cwd, file) => {
    const controller = new AbortController();
    const pending = runCliProcess(process.execPath, [file], {
      cwd,
      timeoutMs: 5000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, /aborted/);
  });
});

test("ordinary CLI exit settles a descendant that outlives its parent", async () => {
  await fixture(
    "const fs=require('fs'),{spawn}=require('child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('child.pid',String(child.pid));process.exit(0);",
    async (cwd, file) => {
      const result = await runCliProcess(process.execPath, [file], {
        cwd,
        timeoutMs: 5000,
      });
      assert.equal(result.code, 0);
      const pid = Number(await readFile(path.join(cwd, "child.pid"), "utf8"));
      assert.throws(() => process.kill(pid, 0));
    },
  );
});

test("CLI generation arguments disable tools and omit prompt commands", () => {
  const args = cliArguments("codex-cli", "gpt-6.1-sol", "C:\\scratch", schema, [
    "C:\\scratch\\image.png",
  ]);
  for (const flag of [
    "--ignore-user-config",
    "--ignore-rules",
    "--ephemeral",
    "--output-schema",
    "--image",
  ])
    assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  for (const feature of [
    "shell_tool",
    "unified_exec",
    "computer_use",
    "hooks",
    "plugins",
    "apps",
    "browser_use",
    "in_app_browser",
    "code_mode",
    "artifact",
    "multi_agent",
  ])
    assert.ok(
      args.some(
        (arg, index) => arg === "--disable" && args[index + 1] === feature,
      ),
    );
  assert.ok(!args.some((arg) => arg.includes("dangerously")));
  assert.equal(args.at(-1), "-");
  const claude = cliArguments("claude-cli", "sonnet", "unused", schema, []);
  assert.equal(claude[claude.indexOf("--tools") + 1], "");
  assert.equal(claude[claude.indexOf("--disallowedTools") + 1], "*");
  assert.equal(claude[claude.indexOf("--setting-sources") + 1], "");
  assert.ok(claude.includes("--bare"));
  assert.ok(claude.includes("--strict-mcp-config"));
  for (const kind of ["codex-cli", "claude-cli"] as const)
    assert.ok(
      !cliArguments(kind, "default", "scratch", schema, []).includes("--model"),
    );
  assert.throws(
    () => cliArguments("claude-cli", "sonnet", "unused", schema, ["image.png"]),
    /image input/,
  );
});

test("Codex proposal catalog removes metadata-controlled tools and preserves its default", () => {
  const original = {
    models: [
      {
        slug: "example-default",
        priority: 0,
        apply_patch_tool_type: "freeform",
        shell_type: "shell_command",
        experimental_supported_tools: ["tool"],
        tool_mode: "code_mode_only",
      },
      { slug: "other", priority: 2 },
    ],
  };
  const catalog = codexProposalCatalog(original, "default");
  assert.equal(catalog.models.length, 2);
  assert.equal(catalog.models[0].slug, "example-default");
  assert.equal(catalog.models[0].priority, 0);
  for (const entry of catalog.models) {
    assert.equal(entry.apply_patch_tool_type, null);
    assert.equal(entry.shell_type, "disabled");
    assert.deepEqual(entry.experimental_supported_tools, []);
    assert.equal(entry.tool_mode, "direct");
    assert.equal(entry.node_repl_disabled, true);
  }
  const custom = codexProposalCatalog(original, "custom-provider-model");
  assert.equal(custom.models.at(-1)?.slug, "custom-provider-model");
  assert.equal(custom.models.at(-1)?.apply_patch_tool_type, null);
  assert.equal(original.models[0].apply_patch_tool_type, "freeform");
  assert.throws(
    () => codexProposalCatalog({ models: [] }, "default"),
    /unavailable/,
  );
  assert.throws(
    () =>
      codexProposalCatalog(
        { models: [{ slug: "bad", priority: "0" }] },
        "default",
      ),
    /rejected/,
  );
});

test("Claude proposal mode rejects subscription authentication without exposing credentials", () => {
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fixture-private-credential";
    assert.throws(
      requireClaudeApiKey,
      /ANTHROPIC_API_KEY.*OAuth is unsupported/,
    );
    process.env.ANTHROPIC_API_KEY = "fixture-private-key";
    assert.doesNotThrow(requireClaudeApiKey);
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    if (previousOAuth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousOAuth;
  }
});

test("CLI output must match the caller schema and model names cannot inject flags", () => {
  assert.deepEqual(validateCliAnswer({ action: "draw" }, schema), {
    action: "draw",
  });
  assert.throws(
    () => validateCliAnswer({ action: "draw", extra: 1 }, schema),
    /schema rejected/,
  );
  assert.throws(
    () => validateCliAnswer({ action: 1 }, schema),
    /schema rejected/,
  );
  for (const value of [
    "--shell",
    "m;whoami",
    "m\n--tools",
    "m $(whoami)",
    "",
    "m".repeat(201),
  ])
    assert.equal(validModelName(value), false);
  assert.equal(validModelName("qwen3.6:latest"), true);
});

test("a missing CLI executable rejects without exposing command or environment", async () => {
  await fixture("", async (cwd) => {
    await assert.rejects(
      runCliProcess(path.join(cwd, "not-installed.exe"), [], {
        cwd,
        timeoutMs: 1000,
      }),
      /could not start/,
    );
  });
});

test("CLI rejects malformed UTF-8 and excessive process budgets", async () => {
  await fixture(
    "process.stdout.write(Buffer.from([255,254]))",
    async (cwd, file) => {
      await assert.rejects(
        runCliProcess(process.execPath, [file], { cwd, timeoutMs: 5000 }),
        /encoding rejected/,
      );
      await assert.rejects(
        runCliProcess(process.execPath, [file], { cwd, timeoutMs: 120001 }),
        /budget rejected/,
      );
    },
  );
});

test("Claude refuses cached managed configuration before starting a model request", async () => {
  await fixture("", async (cwd) => {
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cwd;
    try {
      await writeFile(
        path.join(cwd, "managed-settings.json"),
        JSON.stringify({
          hooks: { SessionStart: [{ command: "not-executed" }] },
        }),
      );
      await assert.rejects(
        assertClaudePolicyIsUnmanaged(cwd),
        /managed configuration/,
      );
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});

test("Codex strict schema placeholders preserve the original optional-field contract", () => {
  const contract = {
    type: "object",
    additionalProperties: false,
    properties: {
      kind: { type: "string" },
      optional: { type: "string" },
      nullable: { type: ["string", "null"] },
      steps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string" },
            detail: { type: "string" },
          },
          required: ["action"],
        },
      },
    },
    required: ["kind", "steps"],
  };
  const wire = codexOutputSchema(contract) as { required: string[] };
  assert.deepEqual(wire.required, ["kind", "optional", "nullable", "steps"]);
  assert.deepEqual(
    decodeCodexAnswer(
      {
        kind: "action",
        optional: null,
        nullable: null,
        steps: [{ action: "draw", detail: null }],
      },
      contract,
    ),
    { kind: "action", nullable: null, steps: [{ action: "draw" }] },
  );
  assert.throws(
    () =>
      decodeCodexAnswer(
        { kind: null, optional: null, nullable: null, steps: [] },
        contract,
      ),
    /schema rejected/,
  );
  assert.throws(
    () =>
      decodeCodexAnswer(
        {
          kind: "action",
          optional: null,
          nullable: null,
          steps: [],
          injected: "x",
        },
        contract,
      ),
    /schema rejected/,
  );
  assert.equal(JSON.stringify(contract).includes("anyOf"), false);
});
