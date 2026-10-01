"""Run the maintained console evaluation with separate review output paths."""
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import tempfile

folder = Path(__file__).resolve().parent
package = folder.parents[1] / "computer-use-runtime"
sys.path.insert(0, str(package / "scripts"))
from process_supervisor import run_command

spec = importlib.util.spec_from_file_location("console_review_identity", package / "scripts/source-identity.py")
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)
source_before = identity.source_identity(package)
evaluation = package / "evaluation/review-console.ts"
original = evaluation.read_text(encoding="utf-8")
code = re.sub(r'from "\.\./src/([^\"]+)\.js"', lambda match: "from " + json.dumps((package / "src" / (match.group(1) + ".ts")).as_uri()), original)
code = code.replace('from "playwright"', "from " + json.dumps((package / "node_modules/playwright/index.mjs").as_uri()))
for name in ["review-console.png", "review-console-mobile.png", "review-console-failure.png", "review-console.json"]:
    code = code.replace("evidence/" + name, (folder / name).as_posix())
environment = dict(os.environ)
environment["CUR_REVIEW_TRAINING"] = "0"
environment["CUR_REVIEW_REPORT"] = str(folder / "console-verification.json")
with tempfile.TemporaryDirectory(prefix="rig-console-review-") as temporary:
    copied = Path(temporary) / "console-review.mts"
    copied.write_text(code, encoding="utf-8")
    command = ["node", "--import", "tsx", str(copied)]
    result = run_command(command, cwd=package, timeout=180, env=environment)
(folder / "verification-logs/console-review.log").write_bytes(result.output)
source_after = identity.source_identity(package)
report = {
    "status": "PASS" if result.exit_code == 0 and source_before == source_after else "FAIL",
    "finishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "exitCode": result.exit_code,
    "timedOut": result.timed_out,
    "cleanupErrors": result.cleanup_errors,
    "sourceBefore": source_before,
    "sourceAfter": source_after,
    "sourceStable": source_before == source_after,
    "evaluation": "computer-use-runtime/evaluation/review-console.ts",
    "evaluationSha256": hashlib.sha256(evaluation.read_bytes()).hexdigest(),
    "transformations": "Only module import paths and report/screenshot destinations change in an automatically removed copy. Real training is disabled.",
    "report": "console-verification.json",
    "log": "verification-logs/console-review.log",
}
(folder / "console-command.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print(result.output.decode("utf-8", errors="replace"))
print(json.dumps({key: report[key] for key in ["status", "exitCode", "sourceStable"]}))
raise SystemExit(0 if report["status"] == "PASS" else 1)
