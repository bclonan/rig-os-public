import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import { hash } from "../src/storage/index.js";

// Read-only evaluator audit. This never launches an editor, sends input, or moves a window.
const path = resolve("evaluation/native-effects.ts");
const bytes = readFileSync(path),
  source = bytes.toString();
const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
const checks: { name: string; line: number; callback: ts.ArrowFunction }[] = [];
let acknowledgment: ts.ArrowFunction | undefined;
function visit(node: ts.Node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(tree) === "acknowledged" &&
    node.initializer &&
    ts.isArrowFunction(node.initializer)
  )
    acknowledgment = node.initializer;
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(tree) === "check" &&
    node.arguments.length === 2 &&
    ts.isStringLiteral(node.arguments[0]) &&
    ts.isArrowFunction(node.arguments[1])
  ) {
    checks.push({
      name: node.arguments[0].text,
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      callback: node.arguments[1],
    });
  }
  ts.forEachChild(node, visit);
}
visit(tree);
const stale = checks.find(
  (check) => check.name === "stale content rejects without further effect",
);
assert.ok(stale, "Reviewed stale-content callback must exist");
const receipts: unknown[] = [];
const independent = {
  text: "Original unmutated public text",
  held: { right: false, control: false, shift: false, leftButton: false },
};
const executable =
  ts.transpileModule(
    (acknowledgment
      ? "const acknowledged=" + acknowledgment.getText(tree) + ";\n"
      : "") +
      "const evaluate=" +
      stale.callback.getText(tree),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2023 },
    },
  ).outputText + "\nevaluate";
const evaluate = vm.runInNewContext(executable, {
  assert,
  randomUUID,
  adapter: {
    observe: async () => ({ id: "original-observation" }),
    execute: async (action: any) => {
      const receipt = {
        phase: "rejected",
        actionId: action.id,
        runId: action.runId,
        detail: "content changed after observation",
      };
      receipts.push(receipt);
      return receipt;
    },
  },
  action: (_observation: unknown, operation: string, args: unknown) => ({
    id: randomUUID(),
    runId: "read-only-evaluator-double",
    operation,
    args,
  }),
  state: async () => structuredClone(independent),
  released: (value: any) => assert.deepEqual(value.held, independent.held),
});
let counterexampleAccepted = false,
  counterexampleError: string | undefined;
try {
  await evaluate();
  counterexampleAccepted = true;
} catch (error) {
  counterexampleError = String(error);
}
const inlineStrictReceipt = (callback: ts.ArrowFunction) => {
  const text = callback.getText(tree);
  return (
    /assert\.equal\(receipt\.phase,\s*["']acknowledged["']/.test(text) &&
    /assert\.equal\(receipt\.actionId,\s*requested\.id/.test(text) &&
    /assert\.equal\(receipt\.runId,\s*requested\.runId/.test(text)
  );
};
const sharedAcknowledgmentStrict = acknowledgment
  ? inlineStrictReceipt(acknowledgment)
  : false;
const strictReceipt = (callback: ts.ArrowFunction) =>
  inlineStrictReceipt(callback) ||
  (sharedAcknowledgmentStrict &&
    /acknowledged\(receipt,\s*requested\)/.test(callback.getText(tree)));
const receiptFaults: {
  phase: string;
  actionId: string;
  runId: string;
  rejected: boolean;
}[] = [];
if (acknowledgment) {
  const code =
    ts.transpileModule("const acknowledged=" + acknowledgment.getText(tree), {
      compilerOptions: { target: ts.ScriptTarget.ES2023 },
    }).outputText + "\nacknowledged";
  const helper = vm.runInNewContext(code, { assert });
  for (const receipt of [
    { phase: "rejected", actionId: "expected", runId: "expected-run" },
    { phase: "acknowledged", actionId: "foreign", runId: "expected-run" },
    { phase: "acknowledged", actionId: "expected", runId: "foreign" },
  ]) {
    let rejected = false;
    try {
      helper(receipt, { id: "expected", runId: "expected-run" });
    } catch {
      rejected = true;
    }
    receiptFaults.push({ ...receipt, rejected });
  }
}
const direct = checks.filter((check) =>
  [
    "click focuses edit and changes caret",
    "drag creates actual text selection",
  ].includes(check.name),
);
const findings = [
  ...(counterexampleAccepted
    ? [
        {
          severity: "qualification-blocker",
          check: stale.name,
          line: stale.line,
          problem:
            "The extracted actual callback accepts two rejected receipts and unchanged fixture text. It does not prove its controlled mutation occurred.",
          repair:
            "Require a bound acknowledged mutation receipt and independently assert before.text equals the unique mutation value before trying the stale action.",
        },
      ]
    : []),
  ...direct
    .filter((check) => !strictReceipt(check.callback))
    .map((check) => ({
      severity: "qualification-blocker",
      check: check.name,
      line: check.line,
      problem:
        "The direct effect case does not explicitly require a bound acknowledged receipt for its requested action.",
      repair:
        "Assert receipt.phase, receipt.actionId and receipt.runId before qualifying the independent effect.",
    })),
];
const directory = resolve(
  "evidence/completion/review",
  "native-evaluator-" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    "-" +
    randomUUID(),
);
mkdirSync(directory, { recursive: true });
const report = {
  schemaVersion: 1,
  reviewerRole:
    "read-only requirements/security engineer; evaluator written by another agent",
  source: path,
  sha256: hash(bytes),
  reviewedAt: new Date().toISOString(),
  verdict: findings.length
    ? "CHANGES REQUIRED"
    : "PASS FOR STATED EVALUATOR SCOPE",
  findings,
  checks: checks.map(({ callback: _callback, ...check }) => check),
  counterexample: {
    evidenceLevel:
      "extracted real evaluator callback with explicitly labeled protocol fault doubles",
    accepted: counterexampleAccepted,
    error: counterexampleError,
    receipts,
    independentState: independent,
    noRealDesktopEffects: true,
    noNativeScoreClaim: true,
  },
  receiptFaults,
  auditCorrection:
    "An earlier checker recognized inline assertions only and reported false positives after the evaluator gained its shared receipt helper. This report extracts and executes the actual helper and preserves earlier reports unchanged.",
  supportedScope: [
    "Independent Win32 edit text, caret, selection, first visible line, scroll position, focus, cursor and GetAsyncKeyState checks for the evaluator-owned editor.",
    "Actual two-monitor inventory and owned HWND transfer with independent GetWindowRect/GetDpiForWindow/cursor measurement, old-frame no-effect rejection and restored original position.",
    "Cancellation independently witnesses an in-flight held key, awaits Runtime cancellation, permits exactly one dispatched action, and verifies key release and no following text effect.",
  ],
  limits: [
    "The fixture-state reader runs in a separate worker and queries Win32 state, but shares native executable/source with the actuator. The transfer geometry/cursor probe uses an additional independent PowerShell process.",
    "Two monitors with the same reported DPI do not establish mixed physical display scaling.",
    "No SendInput partial-failure injection, real hardware interaction, arbitrary application effect, generic stale-HWND test or native event/selective-cache qualification is present in this evaluator.",
    "Live outcome reports require exact evaluator/native/binary hashes and an unchanged whole-source fingerprint. This read-only review is not a fresh live qualification.",
  ],
};
writeFileSync(join(directory, "review.json"), JSON.stringify(report, null, 2), {
  flag: "wx",
});
writeFileSync(join(directory, "extracted-stale-callback.js"), executable, {
  flag: "wx",
});
console.log(
  JSON.stringify({
    verdict: report.verdict,
    findings: findings.length,
    evaluatorSha256: report.sha256,
    directory,
  }),
);
