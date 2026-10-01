import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  CandidateGuard,
  candidateOperation,
  candidateSources,
  prepareCandidate,
  protectedInventory,
  requiredAuthority,
} from "../src/development/candidate.js";
import { hash } from "../src/util/canonical.js";

const trainingOriginMembers = [
  "manifest.json",
  "results.json",
  "audit-sealed.json",
  "selection.json",
  "sources/learner/model.py",
  "sources/learner/model_v4.py",
  "sources/learner/followup_v4_train.py",
  "sources/learner/recorded.py",
  "sources/src/learner/descriptor.ts",
  "sources/evaluation/learning-followup-v4.protocol.json",
].map((name) => "evidence/learning-followup-v4-training-origin-v1/" + name);

function put(root: string, name: string, data = name) {
  const path = join(root, name);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, data);
  return path;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cur-candidate-boundary-"));
  for (const name of requiredAuthority) put(root, name);
  for (const name of candidateSources)
    put(root, "learner/" + name, "# editable candidate source\n");
  for (const name of [
    "src/skills/index.ts",
    "src/learner/audit.ts",
    "package-lock.json",
    ".github/workflows/quality.yml",
    "native/target/release/computer-use-native.exe",
    "native/target/release/disposable-editor.exe",
    "models/17/trained.onnx",
    "datasets/train/manifest.json",
    "evidence/learning-followup-v4/protocol.json",
    "evidence/learning-followup-v4/browser/selection.json",
    "evidence/learning-followup-v4/browser/results.json",
    "evidence/learning-followup-v4/browser/audit-sealed.json",
    "evidence/learning-followup-v4/browser/train-images/before.png",
    ...trainingOriginMembers,
  ])
    put(root, name);
  put(root, "package.json", '{"type":"module"}');
  return { root, path: prepareCandidate(root, "owned-candidate") };
}
function editManifest(
  path: string,
  mutate: (manifest: { protected: Record<string, string> }) => void,
) {
  const file = join(path, "candidate.json"),
    manifest = JSON.parse(readFileSync(file, "utf8"));
  mutate(manifest);
  writeFileSync(file, JSON.stringify(manifest));
}

test("candidate inventory covers current authority while edits and review outputs stay isolated", () => {
  const { root, path } = fixture(),
    guard = new CandidateGuard(root, path);
  const before = protectedInventory(root);
  assert.ok(before["src/learner/qualification.ts"]);
  assert.ok(before["evaluation/learning-followup-v4-audit.ts"]);
  for (const name of trainingOriginMembers) assert.ok(before[name], name);
  assert.ok(
    before["evidence/learning-followup-v4/browser/train-images/before.png"],
  );
  put(
    root,
    "evidence/completion/review/new-report.json",
    "ordinary mutable examiner output",
  );
  put(
    root,
    "evidence/learning-followup-v4/browser/train-store/runtime.sqlite",
    "operational database",
  );
  put(path, "learner/train.py", "# reviewed process improvement\n");
  guard.verify();
  assert.equal(
    guard.changes().find((change) => change.file === "train.py")?.changed,
    true,
  );
  assert.deepEqual(protectedInventory(root), before);
});

for (const name of [
  "src/learner/qualification.ts",
  "evaluation/learning-followup-v4-audit.ts",
  "src/runtime/policy.ts",
  "evaluation/learning-followup-v4.protocol.json",
  "src/learner/index.ts",
  "src/skills/index.ts",
  "package-lock.json",
  ".github/workflows/quality.yml",
  "native/target/release/computer-use-native.exe",
  "native/target/release/disposable-editor.exe",
  "models/17/trained.onnx",
  "datasets/train/manifest.json",
  "evidence/learning-followup-v4/browser/selection.json",
  "evidence/learning-followup-v4/browser/results.json",
  "evidence/learning-followup-v4/browser/train-images/before.png",
  ...trainingOriginMembers,
])
  test(
    "candidate denies changed protected bytes before spawning: " + name,
    async () => {
      const { root, path } = fixture();
      put(root, name, "changed");
      let calls = 0;
      const { report } = await candidateOperation(
        root,
        path,
        "check",
        async () => {
          calls++;
        },
      );
      assert.equal(calls, 0);
      assert.equal(report.status, "FAIL");
      assert.equal(report.protectedFilesUnchanged, false);
      assert.match(report.errors.join("\n"), /Protected file changed/);
    },
  );

test("editable manifest cannot omit, add or self-attest changed authority", () => {
  for (const change of ["omit", "add", "rehash"] as const) {
    const { root, path } = fixture();
    editManifest(path, (manifest) => {
      if (change === "omit")
        delete manifest.protected["src/learner/qualification.ts"];
      if (change === "add") manifest.protected["outside.json"] = "a".repeat(64);
      if (change === "rehash")
        manifest.protected["src/learner/qualification.ts"] = hash(
          readFileSync(put(root, "src/learner/qualification.ts", "changed")),
        );
    });
    assert.throws(
      () => new CandidateGuard(root, path),
      /does not match trusted receipt/,
    );
  }
});

test("trusted inventory rejects missing receipt entries, deleted files and new authority", () => {
  for (const change of [
    "receipt-omission",
    "delete",
    "new-source",
    "new-protocol",
    "new-binary",
    "new-workflow",
  ] as const) {
    const { root, path } = fixture();
    if (change === "receipt-omission") {
      editManifest(path, (manifest) => {
        delete manifest.protected["src/skills/index.ts"];
      });
      put(
        root,
        ".candidates/.protected/owned-candidate.json",
        readFileSync(join(path, "candidate.json"), "utf8"),
      );
    } else if (change === "delete")
      renameSync(
        join(root, "src/skills/index.ts"),
        join(root, "deleted-authority.backup"),
      );
    else {
      const path =
        change === "new-source"
          ? "src/learner/new-promotion.ts"
          : change === "new-protocol"
            ? "evidence/learning-followup-v5/protocol.json"
            : change === "new-binary"
              ? "native/target/release/new-worker.exe"
              : ".github/workflows/new-gate.yml";
      put(root, path, "new protected authority");
    }
    assert.throws(
      () => new CandidateGuard(root, path),
      /Protected inventory changed/,
    );
  }
});

test("candidate refuses root and interior junction escapes", () => {
  for (const directory of [
    "candidate",
    "models",
    "learner",
    "cache",
  ] as const) {
    const { root, path } = fixture(),
      outside = mkdtempSync(join(tmpdir(), "cur-candidate-outside-"));
    if (directory === "candidate") {
      const linked = join(root, ".candidates", "escape");
      symlinkSync(outside, linked, "junction");
      assert.throws(() => new CandidateGuard(root, linked), /Linked path/);
    } else {
      renameSync(join(path, directory), join(path, directory + "-original"));
      symlinkSync(outside, join(path, directory), "junction");
      assert.throws(() => new CandidateGuard(root, path), /Linked path/);
    }
  }
  const { root } = fixture();
  assert.throws(() => new CandidateGuard(root, root), /escapes workspace/);
});

test("trusted Cargo hard links remain protected and candidate hard links are rejected", () => {
  const { root, path } = fixture(),
    worker = join(root, "native/target/release/computer-use-native.exe"),
    alias = join(root, "native/target/release/deps/worker.exe");
  mkdirSync(resolve(alias, ".."), { recursive: true });
  linkSync(worker, alias);
  const guard = new CandidateGuard(root, path);
  guard.verify();
  writeFileSync(alias, "changed through Cargo alias");
  assert.throws(() => guard.verify(), /Protected file changed/);
  const fresh = fixture();
  linkSync(
    join(fresh.root, "models/17/trained.onnx"),
    join(fresh.path, "models/aliased.onnx"),
  );
  assert.throws(
    () => new CandidateGuard(fresh.root, fresh.path),
    /Linked path/,
  );
});

for (const datasetEnv of ["CUR_DATASET_BUNDLE", "cur_dataset_bundle"])
  test(
    "actual child isolates outputs and clears inherited dataset " + datasetEnv,
    async () => {
      const { root, path } = fixture();
      const previous = Object.fromEntries(
        Object.entries(process.env).filter(([name]) =>
          /^CUR_DATASET_BUNDLE$/i.test(name),
        ),
      );
      for (const name of Object.keys(previous)) delete process.env[name];
      process.env[datasetEnv] = join(root, "protected-private-bundle.json");
      try {
        const { report } = await candidateOperation(
          root,
          path,
          "run",
          async (guard, report) => {
            const child = guard.child(process.execPath, [
              "-e",
              "const f=require('node:fs'),p=require('node:path');if(Object.keys(process.env).some(name=>/^CUR_DATASET_BUNDLE$/i.test(name)))process.exit(9);f.writeFileSync('datasets/local.json',process.cwd());f.writeFileSync(p.join(process.env.CUR_MODEL_DIR,'candidate.onnx'),'candidate bytes');console.log(process.env.CUR_MODEL_DIR);",
            ]);
            report.training = child;
            assert.equal(child.exitCode, 0);
            assert.equal(child.protectionError, undefined);
          },
        );
        assert.equal(report.status, "PASS");
        assert.equal(
          readFileSync(join(path, "datasets/local.json"), "utf8"),
          path,
        );
        assert.equal(
          readFileSync(join(path, "models/candidate.onnx"), "utf8"),
          "candidate bytes",
        );
        assert.equal(existsSync(join(root, "models/candidate.onnx")), false);
        assert.match(report.activation, /not performed/);
      } finally {
        for (const name of Object.keys(process.env))
          if (/^CUR_DATASET_BUNDLE$/i.test(name)) delete process.env[name];
        Object.assign(process.env, previous);
      }
    },
  );

test("failed child still checks protection and retains exit, stdout and stderr", async () => {
  const { root, path } = fixture();
  const { report, output } = await candidateOperation(
    root,
    path,
    "run",
    async (guard, report) => {
      const child = guard.child(process.execPath, [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],'changed');console.log('owned output');console.error('owned failure');process.exit(7)",
        join(root, "src/learner/qualification.ts"),
      ]);
      report.training = child;
      assert.equal(child.exitCode, 7);
      assert.match(child.protectionError || "", /Protected file changed/);
      throw new Error("Child failed exit " + child.exitCode);
    },
  );
  assert.equal(report.status, "FAIL");
  assert.equal(report.protectedFilesUnchanged, false);
  const saved = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(saved.training.exitCode, 7);
  assert.match(saved.training.stdout, /owned output/);
  assert.match(saved.training.stderr, /owned failure/);
});

test("timeout and runtime failure cannot become a passing report", async () => {
  const { root, path } = fixture();
  const timed = await candidateOperation(
    root,
    path,
    "run",
    async (guard, report) => {
      const child = guard.child(
        process.execPath,
        ["-e", "console.log('before timeout');setInterval(()=>{},1000)"],
        150,
      );
      report.training = child;
      assert.equal(child.exitCode, null);
      assert.match(child.error || "", /ETIMEDOUT/);
      throw new Error(child.error);
    },
  );
  assert.equal(timed.report.status, "FAIL");
  assert.equal(timed.report.protectedFilesUnchanged, true);
  const failed = await candidateOperation(root, path, "run", async () => {
    throw new Error("Runtime independent effect verification failed");
  });
  assert.equal(failed.report.status, "FAIL");
  assert.match(failed.report.errors[0], /Runtime independent/);
  assert.notEqual(timed.output, failed.output);
});

test("actual public check exits nonzero and preserves a failed test child", () => {
  const { root, path } = fixture();
  put(
    root,
    "tests/promotion.test.ts",
    'import {test} from "node:test";test("owned negative",()=>{throw new Error("actual child rejected")});',
  );
  // Dependencies are a trusted read-only resource, outside the protected source trees.
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "junction");
  const prepared = prepareCandidate(root, "public-check");
  assert.ok(path);
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", resolve("scripts/candidate.ts"), "check", prepared],
    { cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true },
  );
  assert.equal(child.status, 1, child.stderr);
  const report = JSON.parse(child.stdout.trim());
  assert.equal(report.status, "FAIL");
  assert.equal(report.tests.exitCode, 1);
  assert.match(
    report.tests.stdout + report.tests.stderr,
    /actual child rejected/,
  );
  assert.equal(report.protectedFilesUnchanged, true);
  assert.match(report.activation, /not performed/);
});

test("public run honors configured training interpreter and never falls back after failure", () => {
  const { root } = fixture();
  put(
    root,
    "tests/promotion.test.ts",
    'import {test} from "node:test";test("owned passing prerequisite",()=>{});',
  );
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "junction");
  const path = prepareCandidate(root, "configured-python"),
    missing = join(root, "missing-python.exe");
  const configuredEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CUR_TRAINING_PYTHON: missing,
  };
  delete configuredEnv.NODE_TEST_CONTEXT;
  configuredEnv.node_test_context = "child-v8";
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", resolve("scripts/candidate.ts"), "run", path],
    {
      cwd: root,
      env: configuredEnv,
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    },
  );
  assert.equal(child.status, 1, child.stderr);
  const report = JSON.parse(child.stdout.trim());
  assert.equal(report.status, "FAIL");
  assert.equal(report.tests.exitCode, 0);
  assert.equal(report.training.command, missing);
  assert.equal(report.training.exitCode, null);
  assert.match(report.training.error, /ENOENT/);
  assert.equal(report.training.cwd, path);
  assert.equal(report.protectedFilesUnchanged, true);
  assert.equal(report.run, undefined);
  assert.match(report.activation, /not performed/);
});

test("public check rejects skipped and todo test reports even when the child exits zero", () => {
  for (const mode of ["skip", "todo"]) {
    const { root } = fixture();
    put(
      root,
      "tests/promotion.test.ts",
      'import {test} from "node:test";test.' +
        mode +
        '("unperformed prerequisite");',
    );
    symlinkSync(
      resolve("node_modules"),
      join(root, "node_modules"),
      "junction",
    );
    const path = prepareCandidate(root, "unperformed-tests");
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", resolve("scripts/candidate.ts"), "check", path],
      { cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true },
    );
    assert.equal(child.status, 1, child.stderr);
    const report = JSON.parse(child.stdout.trim());
    assert.equal(report.status, "FAIL");
    assert.equal(report.tests.exitCode, 0);
    assert.match(
      report.tests.stdout,
      mode === "skip" ? /# skipped 1/ : /# todo 1/,
    );
    assert.equal(report.protectedFilesUnchanged, true);
    assert.match(report.activation, /not performed/);
  }
});

test("public candidate path canonicalization respects Windows and POSIX filesystem casing", () => {
  const { root } = fixture();
  put(
    root,
    "tests/promotion.test.ts",
    'import {test} from "node:test";test("case path prerequisite",()=>{});',
  );
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "junction");
  const path = prepareCandidate(root, "CaseOwned");
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("scripts/candidate.ts"),
      "check",
      path.toLowerCase(),
    ],
    { cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true },
  );
  if (process.platform === "win32") {
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout.trim());
    assert.equal(report.status, "PASS");
    assert.equal(report.tests.exitCode, 0);
    assert.equal(report.protectedFilesUnchanged, true);
  } else {
    assert.equal(child.status, 1, child.stderr);
    assert.equal(JSON.parse(child.stdout.trim()).status, "FAIL");
  }
});
