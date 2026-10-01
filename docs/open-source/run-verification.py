"""Run the documented local quality checks without using the user's service store."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
folder = Path(__file__).resolve().parent
package = folder.parents[1] / "computer-use-runtime"
sys.path.insert(0, str(package / "scripts"))
from process_supervisor import run_command

spec = importlib.util.spec_from_file_location("release_review_identity", package / "scripts/source-identity.py")
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)
npm = "npm.cmd" if os.name == "nt" else "npm"
commands = [
    ("node-quality", [npm, "run", "check"], 300),
    ("sealed-audit-integrity", [npm, "run", "verify:audit"], 180),
    ("dependency-audit", [npm, "audit", "--audit-level=high"], 180),
    ("rust-format", ["cargo", "fmt", "--manifest-path", "native/Cargo.toml", "--", "--check"], 180),
    ("rust-clippy", ["cargo", "clippy", "--manifest-path", "native/Cargo.toml", "--all-targets", "--", "-D", "warnings"], 300),
    ("git-whitespace", ["git", "diff", "--check", "--", "."], 180),
    ("python-syntax", [sys.executable, "-c", "import pathlib,py_compile; files=[p for d in ['learner','native/unix','sdk','examples','scripts','evaluation','tests'] for p in pathlib.Path(d).rglob('*.py') if '__pycache__' not in p.parts]; [py_compile.compile(str(p),doraise=True) for p in files]; print(str(len(files))+' Python files compiled')"], 180),
    ("python-tests", [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "*_test.py"], 300),
]
logs = folder / "verification-logs"
logs.mkdir(parents=True, exist_ok=True)
report = {
    "status": "RUNNING",
    "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "platform": sys.platform,
    "sourceBefore": identity.source_identity(package),
    "checks": [],
    "scope": "Local unit and contract tests, build, static checks and saved-audit integrity. No live desktop automation or new learning qualification.",
}

def persist():
    (folder / "verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

persist()
with tempfile.TemporaryDirectory(prefix="rig-open-source-checks-") as temporary:
    environment = dict(os.environ)
    environment["CUR_DATA"] = str(Path(temporary) / "service")
    environment["CUR_PORT"] = "0"
    environment["CUR_URL"] = "http://127.0.0.1:1"
    environment["CUR_TOKEN_FILE"] = str(Path(temporary) / "service" / "service.token")
    environment["PYTHONPYCACHEPREFIX"] = str(Path(temporary) / "pycache")
    report["storeIsolation"] = "CUR_DATA and CUR_TOKEN_FILE point to an automatically removed temporary directory; CUR_PORT=0 and CUR_URL uses an unavailable loopback port."
    for name, command, timeout in commands:
        started = time.perf_counter()
        result = run_command(command, cwd=package, timeout=timeout, env=environment)
        output = result.output.decode("utf-8", errors="replace")
        log = logs / (name + ".log")
        log.write_text(output, encoding="utf-8")
        item = {"name": name, "command": command, "exitCode": result.exit_code, "seconds": round(time.perf_counter() - started, 3), "log": log.relative_to(folder).as_posix(), "timedOut": result.timed_out, "interrupted": result.interrupted, "error": result.error, "cleanupErrors": result.cleanup_errors}
        if name == "node-quality":
            counts = re.search(r"(?:#|ℹ) tests (\d+)", output)
            if counts:
                item["tests"] = int(counts.group(1))
        if name == "python-tests":
            counts = re.search(r"Ran (\d+) tests", output)
            skips = re.search(r"skipped=(\d+)", output)
            if counts:
                item["tests"] = int(counts.group(1))
            if skips:
                item["skipped"] = int(skips.group(1))
        report["checks"].append(item)
        persist()
        print(json.dumps(item), flush=True)
        if result.exit_code:
            print(output[-4000:], flush=True)
        if result.interrupted:
            break
report["sourceAfter"] = identity.source_identity(package)
report["sourceStable"] = report["sourceBefore"] == report["sourceAfter"]
report["status"] = "PASS" if report["sourceStable"] and len(report["checks"]) == len(commands) and all(check["exitCode"] == 0 for check in report["checks"]) else "FAIL"
report["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
persist()
print(json.dumps({"status": report["status"], "sourceStable": report["sourceStable"], "checks": len(report["checks"])}), flush=True)
raise SystemExit(0 if report["status"] == "PASS" else 1)
