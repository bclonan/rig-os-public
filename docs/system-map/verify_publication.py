"""Check public map bytes and graph references, without runtime qualification."""
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import unquote

from refresh_publication import maintained_identity, repository_path, sources

folder = Path(__file__).resolve().parent
root = folder.parents[1]
prefix = "window.ARCHITECTURE_SNAPSHOT = "
raw = (folder / "architecture-data.js").read_text(encoding="utf-8-sig")
assert raw.startswith(prefix) and raw.endswith(";\n"), "Invalid snapshot wrapper"
data = json.loads(raw[len(prefix):-2])
binding = json.loads((folder / "PUBLICATION_BINDING.json").read_text(encoding="utf-8-sig"))
assert binding["schemaVersion"] == 1 and binding["scope"] == "Static public documentation refresh only"
identity = maintained_identity()
assert identity["sha256"] == data["meta"]["implementationSha256"] == binding["sourceSha256"], "Maintained source changed"
assert identity["files"] == binding["maintainedFiles"], "Maintained inventory changed"
assert data["meta"]["maintainedFiles"] == len(identity["files"])
files = {item["path"]: item for item in data["files"]}
assert len(files) == len(data["files"]), "Duplicate embedded paths"
assert {name: item["sha256"] for name, item in files.items() if item["maintained"]} == identity["files"]
for name, item in files.items():
    content = repository_path(name).read_bytes()
    assert hashlib.sha256(content).hexdigest() == item["sha256"], "Embedded file hash changed: " + name
    assert content.decode("utf-8-sig").replace("\r\n", "\n") == item["text"], "Embedded text changed: " + name
    assert len(item["text"].split("\n")) == item["lines"], "Line count changed: " + name
assert binding["documents"] == {name: item["sha256"] for name, item in files.items() if not item["maintained"]}
assert set(binding["outputs"]) == {"architecture-data.js", "SOURCE_INDEX.json", "index.html", "canvas.js", "canvas.css"}, "Map control inventory changed"
for name, sha in binding["outputs"].items():
    assert hashlib.sha256((folder / name).read_bytes()).hexdigest() == sha, "Map output changed: " + name
if binding.get("portableEvidence"):
    evidence = binding["portableEvidence"]
    assert hashlib.sha256(repository_path(evidence["path"]).read_bytes()).hexdigest() == evidence["sha256"]
components = {item["id"]: item for item in data["components"]}
assert len(components) == len(data["components"]), "Duplicate components"
for edge in data["relationships"]:
    assert edge["from"] in components and edge["to"] in components, "Missing edge endpoint"
assert len({flow["id"] for flow in data["flows"]}) == len(data["flows"]), "Duplicate journeys"
for flow in data["flows"]:
    assert flow["steps"] and all(step["component"] in components for step in flow["steps"]), "Invalid journey"
for view in data["views"]:
    assert view["components"] and all(name in components for name in view["components"]), "Invalid view"
refs = sources(data)
for ref in refs:
    assert ref["path"] in files and 1 <= ref["line"] <= files[ref["path"]]["lines"], "Invalid source anchor"
    assert ref["sha256"] == files[ref["path"]]["sha256"], "Source anchor hash changed"
index = json.loads((folder / "SOURCE_INDEX.json").read_text(encoding="utf-8-sig"))
assert index["meta"] == data["meta"] and index["sourceReferencesChecked"] == len(refs)
assert index["files"] == [{key: value for key, value in item.items() if key != "text"} for item in data["files"]]
assert index["components"] == [{"id": item["id"], "title": item["title"], "sources": item["sources"]} for item in data["components"]]
html = (folder / "index.html").read_text(encoding="utf-8-sig")
js = (folder / "canvas.js").read_text(encoding="utf-8-sig")
ids = set(re.findall(r'\bid="([^"]+)"', html))
assert set(re.findall(r"\$\('([^']+)'\)", js)) <= ids, "Missing canvas controls"
assert re.findall(r'<script[^>]+src="([^"]+)"', html) == ["architecture-data.js", "canvas.js"]
assert not re.search(r"\b(?:fetch|XMLHttpRequest|WebSocket)\b", js), "Unexpected live transport"
link_count = 0
for name in binding["documents"]:
    if not name.endswith(".md"):
        continue
    path = repository_path(name)
    # Fenced examples can contain placeholder links and are not navigation.
    text = re.sub(r"```[\s\S]*?```", "", path.read_text(encoding="utf-8-sig"))
    for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", text):
        if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I) or target.startswith("#"):
            continue
        target, _, fragment = target.strip("<>").partition("#")
        suffix = re.search(r":(\d+)$", target)
        if suffix:
            fragment = "L" + suffix.group(1)
            target = target[:suffix.start()]
        resolved = (path.parent / unquote(target)).resolve()
        assert resolved.is_relative_to(root.resolve()) and resolved.exists(), name + " missing link " + target
        if re.fullmatch(r"L\d+", fragment):
            assert 1 <= int(fragment[1:]) <= len(resolved.read_text(encoding="utf-8-sig").splitlines()), name + " invalid line " + fragment
        link_count += 1
assert maintained_identity()["files"] == identity["files"], "Source changed during verification"
print(json.dumps({"status": "PASS_STATIC_PUBLIC_DOCUMENTATION", "scope": "Current source, embedded documents, graph, anchors and local links only. No runtime or browser execution.", "sourceSha256": identity["sha256"], "headIsInformational": True, "maintainedFiles": len(identity["files"]), "ordinaryDocuments": len(binding["documents"]), "components": len(components), "relationships": len(data["relationships"]), "journeys": len(data["flows"]), "entities": len(data["entities"]), "sourceReferencesChecked": len(refs), "markdownLinksChecked": link_count}))
