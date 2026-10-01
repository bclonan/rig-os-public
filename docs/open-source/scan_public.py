"""Scan exactly the staged source tree without scanning installed dependencies."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile


def host_metadata(value, hostname):
    fields = {"host", "hostname", "machine", "machineid", "computername", "hostid"}
    if isinstance(value, dict):
        for key, child in value.items():
            field = str(key).replace("_", "").replace("-", "").lower()
            if field in fields and isinstance(child, str) and child.lower() == hostname:
                return True
            if host_metadata(child, hostname):
                return True
    if isinstance(value, list):
        return any(host_metadata(child, hostname) for child in value)
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", type=Path)
    parser.add_argument("--gitleaks", type=Path, required=True)
    args = parser.parse_args()
    root = args.repository.resolve()
    names = list(filter(None, subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")))
    if not names:
        raise SystemExit("Stage the complete public tree before scanning")
    private = []
    hostname = socket.gethostname().lower()
    files = []
    with tempfile.TemporaryDirectory(prefix="rig-public-source-scan-") as temporary:
        tree = Path(temporary) / "source"
        tree.mkdir()
        for name in names:
            path = root / name
            relative = Path(name)
            if relative.is_absolute() or ".." in relative.parts or not path.resolve().is_relative_to(root):
                raise SystemExit("Invalid publication path")
            for ancestor in [*path.parents, path]:
                if ancestor.is_symlink() or getattr(ancestor, "is_junction", lambda: False)():
                    raise SystemExit("Publication contains a linked file")
            raw = path.read_bytes()
            private_host = False
            if path.suffix == ".json":
                private_host = host_metadata(json.loads(raw), hostname)
            elif path.suffix == ".jsonl":
                private_host = any(host_metadata(json.loads(row), hostname) for row in raw.splitlines() if row.strip())
            if re.search(rb"[a-z]:[\\/]+users[\\/]+", raw, re.IGNORECASE) or private_host:
                private.append(name)
            target = tree / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
            files.append({"path": name, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)})
        report_file = Path(temporary) / "gitleaks.json"
        result = subprocess.run([str(args.gitleaks.resolve()), "dir", "--redact=100", "--max-target-megabytes=100", "--no-banner", "--report-format=json", "--report-path=" + str(report_file), str(tree)], capture_output=True, timeout=180)
        findings = json.loads(report_file.read_text(encoding="utf-8")) if report_file.exists() else []
        summaries = [{"rule": item.get("RuleID"), "path": item.get("File", "").replace("\\", "/").removeprefix(tree.as_posix() + "/"), "line": item.get("StartLine")} for item in findings]
    status = "PASS" if not private and result.returncode == 0 and not findings else "FAIL"
    report = {"schemaVersion": 1, "status": status, "scope": "Exact staged files copied to a separate scanner directory. Dependencies, runtime stores and Git metadata are excluded from the directory scan. Git history requires its own scan.", "files": len(files), "bytes": sum(item["bytes"] for item in files), "sourceTreeSha256": hashlib.sha256(json.dumps(files, separators=(",", ":")).encode()).hexdigest(), "gitleaksExitCode": result.returncode, "gitleaksFindings": summaries, "privateOwnerPathOrHostnameFiles": private, "redaction": "100 percent", "maxFileMegabytes": 100}
    (root / "docs/open-source/public-scan.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(report))
    raise SystemExit(0 if status == "PASS" else 1)


if __name__ == "__main__":
    main()
