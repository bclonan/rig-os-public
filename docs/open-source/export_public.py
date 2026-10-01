"""Copy reviewed source into a new directory without importing Git history."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import socket
import subprocess
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "computer-use-runtime"
spec = importlib.util.spec_from_file_location("public_evidence_selection", PACKAGE / "scripts/package_evidence.py")
selection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selection)

ROOT_FILES = {"README.md", ".gitignore", ".gitattributes", "AUTHOR.md", "LICENSE", "CONTRIBUTING.md", "SECURITY.md", ".gitleaks.toml"}
MAP_FILES = {"index.html", "canvas.js", "canvas.css", "architecture-data.js", "SOURCE_INDEX.json", "README.md", "TRACE.md", "VERIFICATION.md", "preview.jpg", "refresh_publication.py", "verify_publication.py", "PUBLICATION_BINDING.json"}
REVIEW_FILES = {"README.md", "CHECKLIST.md", "CLOSURE.json"}
OPEN_SOURCE_FILES = {"README.md", "USAGE.md", "SYSTEM_OVERVIEW.md", "SECURITY_AUDIT.md", "EVIDENCE.md", "VERIFICATION.md", "export_public.py", "test_export_public.py", "normalize_public_evidence.py", "test_normalize_public_evidence.py", "run-verification.py", "run-console-verification.py", "scan_public.py", "security-audit.json", "verification.json", "console-command.json", "console-verification.json", "export-verification.json", "PORTABLE_EVIDENCE.md", "PORTABLE_EVIDENCE.json", "MAP_BROWSER.json", "clean-setup.json", "public-scan.json", "CLONE_VERIFICATION.json", "HISTORY_SCAN.json"}
PRIVATE_PARTS = {".git", ".data", ".tools", ".research", ".candidates", "node_modules", "target", "dist", ".venv", ".venv-desktop", ".ssh", ".gnupg", ".aws", ".azure", "__pycache__", "train-store", "validation-store", "audit-store", "store", "artifacts", "verification-logs", "checks", "release"}
PRIVATE_SUFFIXES = {".log", ".tmp", ".temp", ".pyc", ".token", ".bmp", ".key", ".pem", ".p12", ".pfx", ".keystore", ".jks"}
PRIVATE_NAMES = {"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".evaluator.key", "credentials.json", "secrets.json"}
TEXT_SUFFIXES = {".md", ".json", ".jsonl", ".html", ".css", ".js", ".ts", ".py", ".ps1", ".sh", ".txt", ".yaml", ".yml", ".toml"}
PRIVATE_DATABASE = re.compile(r"\.(?:db|sqlite3?)(?:-(?:wal|shm|journal))?$", re.IGNORECASE)
# A JSON string can escape each backslash more than once. Do not rely on one
# representation of an absolute user directory or emit matched values.
PRIVATE_USER_PATH = re.compile(rb"[a-z]:[\\/]+users[\\/]+", re.IGNORECASE)
HOST_FIELDS = {"host", "hostname", "machine", "machineid", "computername", "hostid"}


def candidates():
    result = set()
    for args in (["git", "ls-files", "-z"], ["git", "ls-files", "--others", "--exclude-standard", "-z"]):
        result.update(filter(None, subprocess.check_output(args, cwd=ROOT).decode().split("\0")))
    # New experiment outputs are ignored by default. Admit the exact controlled
    # evidence inventory explicitly rather than exposing all untracked reports.
    for name in selection.CONTROLLED_FILES:
        if (PACKAGE / name).is_file():
            result.add("computer-use-runtime/" + name)
    for name in selection.CONTROLLED_TREES:
        for folder, directories, filenames in __import__("os").walk(PACKAGE / name, followlinks=False):
            directories[:] = [item for item in directories if item.casefold() not in PRIVATE_PARTS]
            result.update((Path(folder) / item).relative_to(ROOT).as_posix() for item in filenames)
    return sorted(result)


def allowed(name):
    if not name:
        return False
    path = Path(name)
    if name in {"computer-use-runtime/evidence/review-console.png", "computer-use-runtime/evidence/review-console-mobile.png"}:
        return False
    if path.is_absolute() or ".." in path.parts or ":" in path.parts[0]:
        return False
    if any(part.lower() in PRIVATE_PARTS for part in path.parts) or path.suffix.lower() in PRIVATE_SUFFIXES or PRIVATE_DATABASE.search(path.name):
        return False
    if path.name.lower() in PRIVATE_NAMES or path.name.startswith(".env") and path.name not in {".env.example", ".env.sample", ".env.template"}:
        return False
    if name in ROOT_FILES or name.startswith(".github/workflows/"):
        return True
    if name.startswith("computer-use-runtime/"):
        relative = path.relative_to("computer-use-runtime").as_posix()
        if relative == "progress.json":
            return False
        if relative.startswith("evidence/"):
            return selection.evidence_allowed(relative)
        if relative.startswith("models/"):
            return len(path.parts) > 2 and path.parts[2] in {"17", "41", "73", "recorded-candidate"}
        return True
    if name.startswith("docs/open-source/"):
        return len(path.parts) == 3 and path.name in OPEN_SOURCE_FILES
    if name.startswith("docs/system-map/"):
        return len(path.parts) == 3 and path.name in MAP_FILES
    if name.startswith("docs/system-review/"):
        return len(path.parts) == 3 and path.name in REVIEW_FILES
    return False


def reject_links(path):
    """Reject link and junction ancestors before resolving or opening a file."""
    for ancestor in [*path.parents, path]:
        if ancestor.is_symlink() or getattr(ancestor, "is_junction", lambda: False)():
            raise RuntimeError("Export refuses a symlink or junction")


def checked_source(name):
    source = ROOT / name
    reject_links(source)
    resolved_root = ROOT.resolve()
    if not source.resolve().is_relative_to(resolved_root):
        raise RuntimeError("Export source resolves outside the checkout")
    return source


def private_host_metadata(value):
    current_host = socket.gethostname().casefold()
    def walk(item):
        if isinstance(item, dict):
            for key, child in item.items():
                field = str(key).replace("_", "").replace("-", "").casefold()
                if field in HOST_FIELDS and isinstance(child, str) and child.casefold() == current_host:
                    return True
                if walk(child):
                    return True
        if isinstance(item, list):
            return any(walk(child) for child in item)
        return False
    return walk(value)


def check_document_metadata(name, data):
    if not name.startswith("docs/") or Path(name).suffix != ".json":
        return
    value = json.loads(data)
    if PRIVATE_USER_PATH.search(data) or private_host_metadata(value):
        raise RuntimeError("Private path or machine metadata remains in documentation: " + name)


def export_public(destination, *, prepare_portable_evidence=False):
    destination = Path(destination).absolute()
    reject_links(destination)
    destination = destination.resolve()
    if destination.exists() or destination == ROOT or destination.is_relative_to(ROOT):
        raise ValueError("Destination must be a new directory outside the original checkout")
    names = candidates()
    selected, source_data, omitted_private_paths, pending_portable = [], {}, [], []
    # Preflight every source before creating a destination. Link errors and
    # private documentation metadata fail without leaving a partial copy.
    for name in names:
        if not allowed(name):
            continue
        source = checked_source(name)
        if not source.is_file():
            continue
        before = source.stat()
        data = source.read_bytes()
        after = source.stat()
        checked_source(name)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise RuntimeError("Export source changed while reading: " + name)
        frozen = name.startswith("computer-use-runtime/evidence/")
        if frozen and PRIVATE_USER_PATH.search(data):
            if not prepare_portable_evidence:
                omitted_private_paths.append(name)
                continue
            pending_portable.append(name)
        check_document_metadata(name, data)
        selected.append(name)
        source_data[name] = data
    destination.mkdir(parents=True)
    copied, modified = [], []
    for name in selected:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        reject_links(target)
        with target.open("xb") as stream:
            stream.write(source_data[name])
        copied.append({"path": name, "sourceSha256": hashlib.sha256(source_data[name]).hexdigest()})
    # Only ordinary documentation is rewritten. Sealed data and source bytes stay exact.
    pattern = re.compile(r"(!?\[[^\]\n]*\]\()([^\s)]+)(\))")
    for name in selected:
        path = destination / name
        if path.suffix != ".md" or name == "computer-use-runtime/REQUEST.md":
            continue
        original = path.read_text(encoding="utf-8-sig")
        value = re.sub(r"C:[\\/]Users[\\/][^\\/\s`\"<>]+[\\/]Documents[\\/]GitHub[\\/]rig-os(?:[\\/]computer-use-runtime)?", "<clone-directory>/computer-use-runtime", original, flags=re.IGNORECASE)
        value = re.sub(r"C:[\\/]Users[\\/][^\\/\s`\"<>]+", "<user-directory>", value, flags=re.IGNORECASE)
        def rewrite_link(match):
            raw = match.group(2)
            if raw.startswith(("https:", "http:", "mailto:", "#")):
                return match.group(0)
            location = unquote(raw.split("#", 1)[0])
            if not location:
                return match.group(0)
            target = (path.parent / location).resolve()
            if target.exists() and target.is_relative_to(destination):
                return match.group(0)
            if "evidence/" in raw or "system-review/" in raw or "release/" in raw or name.startswith("docs/system-map/"):
                evidence = destination / "docs/open-source/EVIDENCE.md"
                relative = __import__("os").path.relpath(evidence, path.parent).replace("\\", "/")
                return match.group(1) + relative + match.group(3)
            return match.group(0)
        value = pattern.sub(rewrite_link, value)
        if value != original:
            path.write_text(value, encoding="utf-8", newline="\n")
            modified.append(name)
    entries = []
    for item in copied:
        data = (destination / item["path"]).read_bytes()
        check_document_metadata(item["path"], data)
        entries.append({**item, "publicSha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "changedForPublication": item["path"] in modified})
    manifest = {"schemaVersion": 1, "scope": "Maintained source and current documentation, selected controlled evidence, no original Git history", "publicationReady": not prepare_portable_evidence, "portableEvidencePreparation": prepare_portable_evidence, "pendingPortableEvidence": pending_portable, "omittedPrivatePathFiles": omitted_private_paths, "qualificationWarning": "An unreviewed preparation copy is private staging only. Normalize controlled evidence, update derivative bindings and scan the resulting bytes before publication. Omitted frozen metadata cannot support its original qualification.", "originalHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(), "files": entries, "modifiedDocumentation": modified, "omittedFiles": len(names) - len(selected), "excludedCategories": ["original Git history", "runtime stores and keys", "raw personal desktop evidence", "upstream inspection copies", "historical review workspaces", "earlier map snapshots", "installed dependencies and build output", "provider weights", "local command logs", "operational progress log"]}
    manifest_path = destination / "docs/open-source/EXPORT_MANIFEST.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {"destination": str(destination), "files": len(entries), "bytes": sum(item["bytes"] for item in entries), "modifiedDocuments": len(modified), "omittedFiles": manifest["omittedFiles"], "publicationReady": manifest["publicationReady"], "pendingPortableEvidenceFiles": len(pending_portable)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--prepare-portable-evidence", action="store_true", help="Create private unreviewed staging for portable evidence normalization. Do not publish this copy.")
    args = parser.parse_args()
    print(json.dumps(export_public(args.destination, prepare_portable_evidence=args.prepare_portable_evidence)))


if __name__ == "__main__":
    main()
