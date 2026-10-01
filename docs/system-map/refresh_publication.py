"""Refresh a public map without relabeling historical runtime qualification."""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import subprocess

folder = Path(__file__).resolve().parent
root = folder.parents[1]
package = root / "computer-use-runtime"
prefix = "window.ARCHITECTURE_SNAPSHOT = "


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def inventory_sha(files):
    combined = hashlib.sha256()
    for name, sha in sorted(files.items()):
        relative = name.removeprefix("computer-use-runtime/")
        combined.update(relative.encode() + b"\0" + sha.encode() + b"\n")
    return combined.hexdigest()


def repository_path(name):
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError("Path leaves repository: " + name)
    return path


def maintained_identity():
    spec = importlib.util.spec_from_file_location(
        "publication_identity", package / "scripts/source-identity.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    paths = set()
    for directory in module.DIRECTORIES:
        paths.update(
            path for path in (package / directory).rglob("*")
            if path.is_file() and "__pycache__" not in path.parts
            and path.suffix in [".ts", ".vue", ".css", ".html", ".py", ".sh", ".ps1", ".rs", ".txt", ".json", ".toml", ".yaml", ".yml"]
        )
    paths.update(package / name for name in module.CONFIGURATION if (package / name).is_file())
    paths.update(path for path in (package / "docs/completion-contract-v1").glob("*") if path.is_file())
    files = {}
    combined = hashlib.sha256()
    for path in sorted(paths, key=lambda item: item.relative_to(package).as_posix()):
        name = path.relative_to(package).as_posix()
        sha = digest(path.read_bytes())
        combined.update(name.encode() + b"\0" + sha.encode() + b"\n")
        files["computer-use-runtime/" + name] = sha
    try:
        head = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=root, text=True, stderr=subprocess.PIPE
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        head = "uncommitted"
    return {"sha256": combined.hexdigest(), "headAtRefresh": head, "files": files}


def sources(data):
    refs = []
    for item in data["components"] + data["relationships"] + data["entities"]:
        refs.extend(item.get("sources", []))
    for flow in data["flows"]:
        for step in flow["steps"]:
            refs.extend(step.get("sources", []))
    return refs


def document_paths():
    names = {"README.md", "AUTHOR.md", "LICENSE", "CONTRIBUTING.md", "SECURITY.md"}
    names.update(path.relative_to(root).as_posix() for path in (root / "docs/open-source").glob("*.md"))
    names.update(path.relative_to(root).as_posix() for path in package.glob("*.md"))
    names.update(path.relative_to(root).as_posix() for path in (package / "docs").glob("*.md"))
    names.update(path.relative_to(root).as_posix() for path in (package / "docs/adr").glob("*.md"))
    names.update("docs/system-map/" + name for name in ["README.md", "TRACE.md", "VERIFICATION.md"])
    names.update("docs/system-review/" + name for name in ["README.md", "CHECKLIST.md"])
    return {name for name in names if repository_path(name).is_file()}


def source_update_record(name):
    path = repository_path(name)
    if not path.is_relative_to((folder / "SOURCE_UPDATES").resolve()):
        raise ValueError("Source update records belong in docs/system-map/SOURCE_UPDATES")
    record = json.loads(path.read_text(encoding="utf-8-sig"))
    if record.get("schemaVersion") != 1 or record.get("kind") != "maintained-source-update":
        raise ValueError("Invalid maintained source update record")
    if record.get("sourceDiffReviewed") is not True or record.get("architectureTraceReviewed") is not True:
        raise ValueError("Source update requires code and architecture review")
    entries = record.get("changedMaintainedFiles", [])
    paths = [item["path"] for item in entries]
    if not entries or len(paths) != len(set(paths)):
        raise ValueError("Empty or duplicate maintained source changes")
    for item in entries:
        relative = PurePosixPath(item["path"])
        if relative.is_absolute() or relative.as_posix() != item["path"] or ".." in relative.parts or "\\" in item["path"]:
            raise ValueError("Source change path must be a relative runtime file")
        if not repository_path("computer-use-runtime/" + item["path"]).is_relative_to(package.resolve()):
            raise ValueError("Source change path leaves the runtime")
        if not item.get("reason") or not item.get("readExtent"):
            raise ValueError("Source change needs a reason and actual read scope")
        if item.get("beforeSha256") == item.get("afterSha256"):
            raise ValueError("Source update lists an unchanged file")
    return record


def validate_trace_lineage(binding):
    updates = binding.get("sourceUpdates", [])
    base = binding.get("sourceUpdateBaseSha256", binding["sourceSha256"])
    expected = base
    records = []
    for item in updates:
        if digest(repository_path(item["path"]).read_bytes()) != item["sha256"]:
            raise ValueError("Bound source update record changed")
        record = source_update_record(item["path"])
        if record["maintainedSourceBeforeSha256"] != expected:
            raise ValueError("Source update chain is discontinuous")
        if item["beforeSourceSha256"] != expected or item["afterSourceSha256"] != record["maintainedSourceAfterSha256"]:
            raise ValueError("Source update binding differs from its record")
        expected = record["maintainedSourceAfterSha256"]
        records.append(record)
    if expected != binding["sourceSha256"]:
        raise ValueError("Source update chain does not reach current source")
    files = dict(binding["maintainedFiles"])
    for record in reversed(records):
        if inventory_sha(files) != record["maintainedSourceAfterSha256"]:
            raise ValueError("Source update after inventory mismatch")
        for item in record["changedMaintainedFiles"]:
            name = "computer-use-runtime/" + item["path"]
            if files.get(name) != item.get("afterSha256"):
                raise ValueError("Source update file chain mismatch: " + name)
            if item.get("beforeSha256") is None:
                files.pop(name, None)
            else:
                files[name] = item["beforeSha256"]
        if inventory_sha(files) != record["maintainedSourceBeforeSha256"]:
            raise ValueError("Source update before inventory mismatch")
    if binding.get("portableEvidence"):
        evidence = binding["portableEvidence"]
        if digest(repository_path(evidence["path"]).read_bytes()) != evidence["sha256"]:
            raise ValueError("Frozen portable evidence record changed")
        portable = json.loads(repository_path(evidence["path"]).read_text(encoding="utf-8-sig"))
        if portable.get("sourceDiffReviewed") is not True or portable["maintainedSourceAfterSha256"] != base:
            raise ValueError("Portable evidence does not bind the source update base")
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    acceptance = parser.add_mutually_exclusive_group()
    acceptance.add_argument("--accept-public-source", action="store_true")
    acceptance.add_argument("--accept-source-update", metavar="RECORD")
    args = parser.parse_args()
    raw = (folder / "architecture-data.js").read_text(encoding="utf-8-sig")
    if not raw.startswith(prefix) or not raw.endswith(";\n"):
        raise ValueError("Invalid map wrapper")
    data = json.loads(raw[len(prefix):-2])
    previous_binding_path = folder / "PUBLICATION_BINDING.json"
    previous_binding = json.loads(previous_binding_path.read_text(encoding="utf-8-sig")) if previous_binding_path.is_file() else {}
    if previous_binding:
        validate_trace_lineage(previous_binding)
    prior = {item["path"]: item for item in data["files"]}
    before = maintained_identity()
    prior_maintained = {name: item["sha256"] for name, item in prior.items() if item["maintained"]}
    changed_source = {
        name for name in set(prior_maintained) | set(before["files"])
        if prior_maintained.get(name) != before["files"].get(name)
    }
    portable = None
    portable_file = root / "docs/open-source/PORTABLE_EVIDENCE.json"
    updates = list(previous_binding.get("sourceUpdates", []))
    trace_record = None
    if previous_binding.get("portableEvidence"):
        portable = json.loads(portable_file.read_text(encoding="utf-8-sig"))
    if changed_source and args.accept_source_update:
        trace_record = source_update_record(args.accept_source_update)
        if trace_record["maintainedSourceBeforeSha256"] != data["meta"]["implementationSha256"]:
            raise ValueError("Source update before fingerprint mismatch")
        if trace_record["maintainedSourceAfterSha256"] != before["sha256"]:
            raise ValueError("Source update after fingerprint mismatch")
        declared = {"computer-use-runtime/" + item["path"]: item for item in trace_record["changedMaintainedFiles"]}
        if set(declared) != changed_source:
            raise ValueError("Source update omits or invents maintained changes")
        for name, item in declared.items():
            if item.get("beforeSha256") != prior_maintained.get(name) or item.get("afterSha256") != before["files"].get(name):
                raise ValueError("Source update file hash mismatch: " + name)
        updates.append({"path": args.accept_source_update, "sha256": digest(repository_path(args.accept_source_update).read_bytes()), "beforeSourceSha256": trace_record["maintainedSourceBeforeSha256"], "afterSourceSha256": trace_record["maintainedSourceAfterSha256"]})
    elif changed_source:
        if not args.accept_public_source:
            raise ValueError("Maintained source changed. Review a source trace before refreshing.")
        portable = json.loads(portable_file.read_text(encoding="utf-8-sig"))
        if not portable.get("sourceDiffReviewed") or portable.get("schemaVersion") != 1:
            raise ValueError("Portable source diff has not been reviewed")
        if portable["maintainedSourceBeforeSha256"] != data["meta"]["implementationSha256"]:
            raise ValueError("Portable before fingerprint mismatch")
        if portable["maintainedSourceAfterSha256"] != before["sha256"]:
            raise ValueError("Portable after fingerprint mismatch")
        declared = {"computer-use-runtime/" + item["path"]: item for item in portable["changedMaintainedFiles"]}
        if set(declared) != changed_source:
            raise ValueError("Portable diff omits or invents maintained changes")
        for name, item in declared.items():
            if not item.get("reason") or item.get("beforeSha256") != prior_maintained.get(name) or item.get("afterSha256") != before["files"].get(name):
                raise ValueError("Portable source hash mismatch: " + name)
    elif args.accept_source_update:
        raise ValueError("No maintained source change to accept")
    names = set(before["files"]) | document_paths()
    disclosure = "docs/open-source/EVIDENCE.md"
    if disclosure not in names:
        raise ValueError("Public evidence disclosure is required")
    files = []
    for name in sorted(names):
        content = repository_path(name).read_bytes()
        text = content.decode("utf-8-sig").replace("\r\n", "\n")
        files.append({"path": name, "sha256": digest(content), "text": text, "lines": len(text.split("\n")), "maintained": name in before["files"]})
    current = {item["path"]: item for item in files}
    anchors = []
    replacements = (trace_record or portable or {}).get("reanchoredReferences", [])
    for ref in sources(data):
        name, line = ref["path"], ref["line"]
        if name not in current:
            if prior.get(name, {}).get("maintained"):
                matches = [item for item in replacements if "computer-use-runtime/" + item["path"] == name and item["beforeLine"] == line]
                if len(matches) != 1:
                    raise ValueError("Removed executable anchor needs an explicit reviewed replacement: " + name + ":" + str(line))
                replacement = matches[0]
                new_name = "computer-use-runtime/" + replacement.get("afterPath", replacement["path"])
                if new_name not in before["files"] or not 1 <= replacement["afterLine"] <= current[new_name]["lines"]:
                    raise ValueError("Invalid replacement executable anchor")
                ref.update({"path": new_name, "line": replacement["afterLine"], "sha256": current[new_name]["sha256"]})
                if replacement.get("afterSymbol"):
                    ref["symbol"] = replacement["afterSymbol"]
                anchors.append({"beforePath": name, "beforeLine": line, "afterPath": new_name, "afterLine": ref["line"], "reason": "Explicit reviewed replacement"})
                continue
            ref.update({"path": disclosure, "line": 1, "symbol": "Historical or private evidence omitted from the public source edition", "sha256": current[disclosure]["sha256"]})
            anchors.append({"beforePath": name, "beforeLine": line, "afterPath": disclosure, "afterLine": 1, "reason": "Evidence disclosure replaces a private record"})
            continue
        old = prior.get(name)
        if old and old["sha256"] != current[name]["sha256"] and not (trace_record and ref.get("sha256") == current[name]["sha256"]):
            old_lines = old["text"].splitlines()
            witness = old_lines[line - 1] if 1 <= line <= len(old_lines) else None
            matches = [at + 1 for at, value in enumerate(current[name]["text"].splitlines()) if value == witness] if witness else []
            inherited = bool(matches)
            if matches:
                ref["line"] = min(matches, key=lambda at: abs(at - line))
            elif name in before["files"]:
                matches = [item for item in replacements if "computer-use-runtime/" + item["path"] == name and item["beforeLine"] == line]
                if len(matches) != 1:
                    raise ValueError("Changed executable anchor needs an explicit reviewed replacement: " + name + ":" + str(line))
                replacement = matches[0]
                new_name = "computer-use-runtime/" + replacement.get("afterPath", replacement["path"])
                if new_name not in before["files"]:
                    raise ValueError("Executable replacement must cite maintained source")
                ref.update({"path": new_name, "line": replacement["afterLine"]})
                if replacement.get("afterSymbol"):
                    ref["symbol"] = replacement["afterSymbol"]
            else:
                ref["line"] = 1
            anchors.append({"beforePath": name, "beforeLine": line, "afterPath": ref["path"], "afterLine": ref["line"], "reason": "Exact source-line inheritance" if inherited else "Explicit reviewed replacement" if name in before["files"] else "Ordinary document was rewritten"})
        name = ref["path"]
        ref["sha256"] = current[name]["sha256"]
        if not 1 <= ref["line"] <= current[name]["lines"]:
            raise ValueError("Source line out of range: " + name)
    old_meta = data["meta"]
    description_adjustments = []
    if portable:
        for component in data["components"]:
            for field in ["summary", "status"]:
                old = component.get(field, "")
                new = old.replace("current 300-file", "earlier 300-file").replace("fresh 300-file", "earlier 300-file")
                if new != old:
                    component[field] = new
                    description_adjustments.append(component["id"] + "." + field)
            details = component.get("details", [])
            for at, text in enumerate(details):
                new = text.replace("current 300-file", "earlier 300-file").replace("fresh 300-file", "earlier 300-file")
                if new != text:
                    details[at] = new
                    description_adjustments.append(component["id"] + ".details." + str(at))
            if component["id"] == "learning-training-origin":
                component["status"] = "Historical qualification is prior evidence. Public-source derivative admission is not fresh model qualification."
                note = "The public edition admits one exact reviewed portable origin derivative. That admission proves origin only. It does not grant historical terminal compatibility or replace a fresh public-source qualification."
                if note not in details:
                    details.append(note)
                    description_adjustments.append(component["id"] + ".publicOriginDerivative")
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat()
    data["files"] = files
    data["meta"] = {
        "repository": old_meta["repository"], "date": stamp[:10], "generatedAt": stamp,
        "head": before["headAtRefresh"], "implementationSha256": before["sha256"],
        "maintainedFiles": len(before["files"]), "sourceTraceOnly": True,
        "scope": "Public source and documentation snapshot. Architecture descriptions retain their source review scope. Private research records are omitted. No runtime, model or platform qualification follows from this refresh.",
        "research": [], "publicationBinding": "docs/system-map/PUBLICATION_BINDING.json",
        "headIsInformational": True,
    }
    output = prefix + json.dumps(data, ensure_ascii=True, separators=(",", ":")) + ";\n"
    index = {"meta": data["meta"], "files": [{key: value for key, value in item.items() if key != "text"} for item in files], "components": [{"id": item["id"], "title": item["title"], "sources": item["sources"]} for item in data["components"]], "sourceReferencesChecked": len(sources(data))}
    after = maintained_identity()
    if after != before:
        raise ValueError("Source changed during documentation refresh")
    (folder / "architecture-data.js").write_text(output, encoding="utf-8", newline="\n")
    (folder / "SOURCE_INDEX.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8", newline="\n")
    binding = {
        "schemaVersion": 1, "scope": "Static public documentation refresh only", "createdAt": stamp,
        "sourceSha256": before["sha256"], "headAtRefresh": before["headAtRefresh"], "headIsInformational": True,
        "maintainedFiles": before["files"], "previousSourceSha256": portable["maintainedSourceBeforeSha256"] if portable else old_meta["implementationSha256"],
        "sourceDiffReviewed": bool(portable or updates),
        "portableEvidence": {"path": "docs/open-source/PORTABLE_EVIDENCE.json", "sha256": digest(portable_file.read_bytes())} if portable else None,
        "sourceUpdateBaseSha256": portable["maintainedSourceAfterSha256"] if portable else previous_binding.get("sourceUpdateBaseSha256", old_meta["implementationSha256"]),
        "sourceUpdates": updates,
        "documents": {name: current[name]["sha256"] for name in sorted(names - set(before["files"]))},
        "omittedEmbeddedRecords": sorted(set(prior) - names), "reanchoredReferences": anchors,
        "descriptionAdjustments": description_adjustments,
        "outputs": {name: digest((folder / name).read_bytes()) for name in ["architecture-data.js", "SOURCE_INDEX.json", "index.html", "canvas.js", "canvas.css"]},
        "runtimeQualification": "Not performed or claimed", "privateHistoricalResearch": "Retained privately; not included in this public snapshot",
    }
    validate_trace_lineage(binding)
    (folder / "PUBLICATION_BINDING.json").write_text(json.dumps(binding, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"status": "PASS_STATIC_PUBLIC_REFRESH", "maintainedFiles": len(before["files"]), "sourceSha256": before["sha256"], "sourceChangesReviewed": len(changed_source), "ordinaryDocuments": len(binding["documents"]), "omittedRecords": len(binding["omittedEmbeddedRecords"]), "reanchoredReferences": len(anchors)}))


if __name__ == "__main__":
    main()
