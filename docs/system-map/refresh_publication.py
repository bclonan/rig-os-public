"""Refresh a public map without relabeling historical runtime qualification."""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

folder = Path(__file__).resolve().parent
root = folder.parents[1]
package = root / "computer-use-runtime"
prefix = "window.ARCHITECTURE_SNAPSHOT = "


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accept-public-source", action="store_true")
    args = parser.parse_args()
    raw = (folder / "architecture-data.js").read_text(encoding="utf-8-sig")
    if not raw.startswith(prefix) or not raw.endswith(";\n"):
        raise ValueError("Invalid map wrapper")
    data = json.loads(raw[len(prefix):-2])
    previous_binding_path = folder / "PUBLICATION_BINDING.json"
    previous_binding = json.loads(previous_binding_path.read_text(encoding="utf-8-sig")) if previous_binding_path.is_file() else {}
    prior = {item["path"]: item for item in data["files"]}
    before = maintained_identity()
    prior_maintained = {name: item["sha256"] for name, item in prior.items() if item["maintained"]}
    changed_source = {
        name for name in set(prior_maintained) | set(before["files"])
        if prior_maintained.get(name) != before["files"].get(name)
    }
    portable = None
    portable_file = root / "docs/open-source/PORTABLE_EVIDENCE.json"
    if changed_source:
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
    elif previous_binding.get("portableEvidence"):
        portable = json.loads(portable_file.read_text(encoding="utf-8-sig"))
        if not portable.get("sourceDiffReviewed") or portable["maintainedSourceAfterSha256"] != before["sha256"]:
            raise ValueError("Retained portable source review no longer matches")
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
    for ref in sources(data):
        name, line = ref["path"], ref["line"]
        if name not in current:
            ref.update({"path": disclosure, "line": 1, "symbol": "Historical or private evidence omitted from the public source edition", "sha256": current[disclosure]["sha256"]})
            anchors.append({"beforePath": name, "beforeLine": line, "afterPath": disclosure, "afterLine": 1, "reason": "Evidence disclosure replaces a private record"})
            continue
        old = prior.get(name)
        if old and old["sha256"] != current[name]["sha256"]:
            old_lines = old["text"].splitlines()
            witness = old_lines[line - 1] if 1 <= line <= len(old_lines) else None
            matches = [at + 1 for at, value in enumerate(current[name]["text"].splitlines()) if value == witness] if witness else []
            inherited = bool(matches)
            if matches:
                ref["line"] = min(matches, key=lambda at: abs(at - line))
            elif name in before["files"]:
                replacements = portable.get("reanchoredReferences", []) if portable else []
                matches = [item for item in replacements if "computer-use-runtime/" + item["path"] == name and item["beforeLine"] == line]
                if len(matches) != 1:
                    raise ValueError("Changed executable anchor needs an explicit reviewed replacement: " + name + ":" + str(line))
                ref["line"] = matches[0]["afterLine"]
            else:
                ref["line"] = 1
            anchors.append({"beforePath": name, "beforeLine": line, "afterPath": name, "afterLine": ref["line"], "reason": "Exact source-line inheritance" if inherited else "Explicit reviewed replacement" if name in before["files"] else "Ordinary document was rewritten"})
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
        "scope": "Public source and documentation snapshot. Prior architecture roles are retained. Private research records are omitted. No runtime, model or platform qualification follows from this refresh.",
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
        "sourceDiffReviewed": bool(portable),
        "portableEvidence": {"path": "docs/open-source/PORTABLE_EVIDENCE.json", "sha256": digest(portable_file.read_bytes())} if portable else None,
        "documents": {name: current[name]["sha256"] for name in sorted(names - set(before["files"]))},
        "omittedEmbeddedRecords": sorted(set(prior) - names), "reanchoredReferences": anchors,
        "descriptionAdjustments": description_adjustments,
        "outputs": {name: digest((folder / name).read_bytes()) for name in ["architecture-data.js", "SOURCE_INDEX.json", "index.html", "canvas.js", "canvas.css"]},
        "runtimeQualification": "Not performed or claimed", "privateHistoricalResearch": "Retained privately; not included in this public snapshot",
    }
    (folder / "PUBLICATION_BINDING.json").write_text(json.dumps(binding, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"status": "PASS_STATIC_PUBLIC_REFRESH", "maintainedFiles": len(before["files"]), "sourceSha256": before["sha256"], "sourceChangesReviewed": len(changed_source), "ordinaryDocuments": len(binding["documents"]), "omittedRecords": len(binding["omittedEmbeddedRecords"]), "reanchoredReferences": len(anchors)}))


if __name__ == "__main__":
    main()
