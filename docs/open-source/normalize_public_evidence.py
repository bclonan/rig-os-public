"""Create explicit portable derivatives in a staging copy, never in the source."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import socket
import subprocess

ROOT = Path(__file__).resolve().parents[2]
PUBLIC_SCOPE = "Portable publication derivative of reviewed training metadata. Model and controlled image bytes are unchanged. This derivative is training provenance only, never successful terminal evidence or a new qualification."
NEUTRAL_ROOT = "/PUBLIC_WORKSPACE/computer-use-runtime"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked_path(destination, name):
    relative = Path(name)
    if relative.is_absolute() or ".." in relative.parts or any(":" in part for part in relative.parts):
        raise ValueError("Publication path must be relative and inside staging")
    path = destination / relative
    for ancestor in [*path.parents, path]:
        if ancestor.is_symlink() or getattr(ancestor, "is_junction", lambda: False)():
            raise ValueError("Publication refuses symlink or junction paths")
    if not path.resolve().is_relative_to(destination.resolve()):
        raise ValueError("Publication path leaves staging")
    if path.is_file() and path.stat().st_nlink != 1:
        raise ValueError("Publication refuses shared hardlinked files")
    return path


def replace_root(data, original_root):
    for original in {str(original_root), original_root.as_posix()}:
        for _ in range(5):
            data = re.sub(re.escape(original.encode()), NEUTRAL_ROOT.encode(), data, flags=re.IGNORECASE)
            original = original.replace("\\", "\\\\")
    return data


def replace_host_metadata(data, hostname):
    pattern = rb'("(?:hostId|host|hostname|computerName|machineId|machine)"\s*:\s*)' + re.escape(json.dumps(hostname).encode())
    return re.sub(pattern, lambda match: match.group(1) + b'"public-fixture-host"', data, flags=re.IGNORECASE)


def remap_hashes(originals, transformed, canonical_original=None, canonical_current=None):
    """Resolve acyclic hash references while preserving original formatting."""
    original_hashes = {name: digest(data) for name, data in originals.items()}
    latest = dict(transformed)
    for _ in range(len(originals) + 2):
        mapping = {original_hashes[name]: digest(data) for name, data in latest.items() if digest(data) != original_hashes[name]}
        if canonical_original is not None:
            mapping[canonical_original] = canonical_current(latest["evidence/results.json"])
        successor = {}
        for name, data in transformed.items():
            successor[name] = re.sub(rb"[0-9a-f]{64}", lambda match: mapping.get(match.group().decode(), match.group().decode()).encode(), data)
        if successor == latest:
            return successor
        latest = successor
    raise RuntimeError("Metadata hash references have a cycle or failed to settle")


def maintained_identity(package, names):
    fingerprint = hashlib.sha256()
    for name in sorted(names):
        fingerprint.update(name.encode() + b"\0" + digest((package / name).read_bytes()).encode() + b"\n")
    return fingerprint.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--rebuild", action="store_true", help="Rebuild staging derivatives from unchanged originals after a reviewed normalization fix")
    args = parser.parse_args()
    destination = args.destination.absolute()
    for ancestor in [*destination.parents, destination]:
        if ancestor.is_symlink() or getattr(ancestor, "is_junction", lambda: False)():
            raise SystemExit("Publication refuses a linked staging directory")
    destination = destination.resolve()
    if destination == ROOT or destination.is_relative_to(ROOT):
        raise SystemExit("Only a separate staging copy can be normalized")
    package = destination / "computer-use-runtime"
    if checked_path(destination, "docs/open-source/PORTABLE_EVIDENCE.json").exists() and not args.rebuild:
        raise SystemExit("Portable derivatives already exist; use a new staging copy")
    export_file = checked_path(destination, "docs/open-source/EXPORT_MANIFEST.json")
    export = json.loads(export_file.read_text(encoding="utf-8"))
    for entry in export["files"]:
        path = checked_path(destination, entry["path"])
        if not args.rebuild and digest(path.read_bytes()) != entry["publicSha256"]:
            raise RuntimeError("Staging file changed since export: " + entry["path"])
    map_root = ROOT if args.rebuild else destination
    map_data = json.loads((map_root / "docs/system-map/architecture-data.js").read_text(encoding="utf-8").removeprefix("window.ARCHITECTURE_SNAPSHOT = ").removesuffix(";\n"))
    maintained = {item["path"].removeprefix("computer-use-runtime/"): item["sha256"] for item in map_data["files"] if item["maintained"]}
    originals = {}
    transformed = {}
    for entry in export["files"]:
        name = entry["path"].removeprefix("computer-use-runtime/")
        if not name.startswith("evidence/") or Path(name).suffix not in {".json", ".jsonl"}:
            continue
        original_path = ROOT / "computer-use-runtime" / name if args.rebuild else package / name
        if args.rebuild:
            for ancestor in [*original_path.parents, original_path]:
                if ancestor.is_symlink() or getattr(ancestor, "is_junction", lambda: False)():
                    raise RuntimeError("Original evidence has a linked path")
        raw = original_path.read_bytes()
        if args.rebuild and digest(raw) != entry["sourceSha256"]:
            raise RuntimeError("Original evidence changed since export: " + name)
        originals[name] = raw
        transformed[name] = replace_host_metadata(replace_root(raw, ROOT / "computer-use-runtime"), socket.gethostname())
    origin_manifest = "evidence/learning-followup-v4-training-origin-v1/manifest.json"
    value = json.loads(transformed[origin_manifest])
    value["scope"] = PUBLIC_SCOPE
    transformed[origin_manifest] = (json.dumps(value, indent=2) + "\n").encode()

    # The original base audit uses JSON.stringify rather than file-byte hashing.
    def canonical_json_hash(data):
        result = subprocess.run(["node", "--input-type=module", "-e", "import{createHash}from'node:crypto';let s='';for await(const c of process.stdin)s+=c;process.stdout.write(createHash('sha256').update(JSON.stringify(JSON.parse(s))).digest('hex'));"], input=data, capture_output=True, check=True)
        return result.stdout.decode()
    final = remap_hashes(originals, transformed, canonical_json_hash(originals["evidence/results.json"]), canonical_json_hash)
    changed_metadata = []
    for name, raw in final.items():
        if raw != originals[name]:
            (package / name).write_bytes(raw)
            changed_metadata.append({"path": "computer-use-runtime/" + name, "beforeSha256": digest(originals[name]), "afterSha256": digest(raw), "reason": "Source-workspace path and machine identity normalization with transitive metadata hashes"})

    if args.rebuild:
        for name in ["src/learner/portable-inputs.ts", "tests/learning-training-origin.test.ts", "tests/learning-finalization.test.ts"]:
            raw = (ROOT / "computer-use-runtime" / name).read_bytes()
            if digest(raw) != maintained[name]:
                raise RuntimeError("Original maintained source changed")
            checked_path(destination, "computer-use-runtime/" + name).write_bytes(raw)
    original_source = (package / "src/learner/portable-inputs.ts").read_text(encoding="utf-8")
    result_hash = digest(final["evidence/learning-followup-v4-training-origin-v1/results.json"])
    seal_hash = digest(final["evidence/learning-followup-v4-training-origin-v1/audit-sealed.json"])
    protocol_hash = json.loads(final[origin_manifest])["protocolHash"]
    tuple_code = '\n// Publication derivatives supply training provenance only. The terminal\n// verifier deliberately retains its original reviewed tuples unchanged.\nconst publicOriginTuple = {\n  protocol: "' + protocol_hash + '",\n  results: "' + result_hash + '",\n  seal: "' + seal_hash + '",\n} as const;\nconst publicOriginScope = ' + json.dumps(PUBLIC_SCOPE) + ';\n'
    source = original_source.replace('\nfunction provenanceError', tuple_code + '\nfunction provenanceError', 1)
    old = 'entry.results === hash(resultBytes) && entry.seal === hash(sealBytes),\n    );'
    new = 'entry.results === hash(resultBytes) && entry.seal === hash(sealBytes),\n    ) ??\n      (publicOriginTuple.results === hash(resultBytes) &&\n      publicOriginTuple.seal === hash(sealBytes)\n        ? publicOriginTuple\n        : undefined);\n  const publicationDerivative = tuple === publicOriginTuple;'
    if old not in source:
        raise RuntimeError("Training origin resolver changed; review the publication patch")
    source = source.replace(old, new, 1)
    source = source.replace('manifest.scope !== originScope', 'manifest.scope !== (publicationDerivative ? publicOriginScope : originScope)', 1)
    source = source.replace('kind: "VERIFIED_HISTORICAL_TRAINING_ORIGIN" as const,', 'kind: publicationDerivative\n      ? ("VERIFIED_PUBLICATION_TRAINING_ORIGIN" as const)\n      : ("VERIFIED_HISTORICAL_TRAINING_ORIGIN" as const),', 1)
    source = source.replace('"Exact already-reviewed result/seal/protocol tuple and rehashed local bytes; the archive digest is descriptive extraction metadata",', 'publicationDerivative\n          ? publicOriginScope\n          : "Exact already-reviewed result/seal/protocol tuple and rehashed local bytes; the archive digest is descriptive extraction metadata",', 1)
    (package / "src/learner/portable-inputs.ts").write_text(source, encoding="utf-8", newline="\n")
    tests_path = package / "tests/learning-training-origin.test.ts"
    tests = tests_path.read_text(encoding="utf-8").replace('"public historical origin binds', '"portable publication origin binds', 1).replace('assert.equal(proof.kind, "VERIFIED_HISTORICAL_TRAINING_ORIGIN");', 'assert.equal(proof.kind, "VERIFIED_PUBLICATION_TRAINING_ORIGIN");', 1)
    tests_path.write_text(tests, encoding="utf-8", newline="\n")
    terminal_path = package / "tests/learning-finalization.test.ts"
    tests = terminal_path.read_text(encoding="utf-8")
    tests = tests.replace('test("historical exception admits exact reviewed bytes only and leaves them unchanged",', 'test("portable publication reports cannot use the historical terminal exception",', 1)
    start = tests.index('  assert.equal(\n    verifyFollowupTerminal(', tests.index('test("portable publication reports'))
    end = tests.index('  assert.throws(', start)
    block = tests[start:end]
    block = block.replace('  assert.equal(\n    verifyFollowupTerminal(', '  assert.throws(\n    () => verifyFollowupTerminal(', 1).replace('    "historical-reviewed",', '    /Legacy audit/,', 1)
    tests = tests[:start] + block + tests[end:]
    terminal_path.write_text(tests, encoding="utf-8", newline="\n")
    # Keep formatting identical to the project's normal TypeScript rules.
    command = [str(ROOT / "computer-use-runtime/node_modules/.bin/prettier.cmd") if __import__("os").name == "nt" else str(ROOT / "computer-use-runtime/node_modules/.bin/prettier"), "--write", "src/learner/portable-inputs.ts", "tests/learning-training-origin.test.ts", "tests/learning-finalization.test.ts"]
    subprocess.run(command, cwd=package, check=True, stdout=subprocess.PIPE)
    changed_source = []
    for name in maintained:
        after = digest((package / name).read_bytes())
        if after != maintained[name]:
            changed_source.append({"path": name, "beforeSha256": maintained[name], "afterSha256": after, "reason": "Exact portable training provenance admission and a regression proving it cannot substitute for signed terminal qualification"})
    if {entry["path"] for entry in changed_source} != {"src/learner/portable-inputs.ts", "tests/learning-training-origin.test.ts", "tests/learning-finalization.test.ts"}:
        raise RuntimeError("Unexpected maintained-source change in publication")
    stable_artifacts = [entry for entry in export["files"] if entry["path"].startswith("computer-use-runtime/") and Path(entry["path"]).suffix in {".png", ".pt", ".onnx"}]
    if any(digest((destination / entry["path"]).read_bytes()) != entry["sourceSha256"] for entry in stable_artifacts):
        raise RuntimeError("Controlled model or image bytes changed")
    for entry in export["files"]:
        path = destination / entry["path"]
        entry["publicSha256"] = digest(path.read_bytes())
        entry["bytes"] = path.stat().st_size
        entry["changedForPublication"] = entry["publicSha256"] != entry["sourceSha256"]
    export["pendingPortableEvidence"] = []
    export["requiresPortableEvidenceNormalization"] = False
    export_file.write_text(json.dumps(export, indent=2) + "\n", encoding="utf-8")
    report = {"schemaVersion": 1, "scope": PUBLIC_SCOPE, "maintainedSourceBeforeSha256": map_data["meta"]["implementationSha256"], "maintainedSourceAfterSha256": maintained_identity(package, maintained), "changedMaintainedFiles": changed_source, "sourceDiffReviewed": False, "changedMetadata": changed_metadata, "unchangedModelsAndImages": len(stable_artifacts), "originalTerminalVerifierUnchanged": digest((package / "src/learner/finalization.ts").read_bytes()) == maintained["src/learner/finalization.ts"], "freshLocalQualificationRequired": True, "neutralReferenceRoot": NEUTRAL_ROOT, "publicationOriginTuple": {"protocol": protocol_hash, "results": result_hash, "seal": seal_hash}}
    (destination / "docs/open-source/PORTABLE_EVIDENCE.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "PREPARED_FOR_REVIEW", "changedMetadataFiles": len(changed_metadata), "changedSourceFiles": len(changed_source), "unchangedModelsAndImages": len(stable_artifacts), "maintainedSourceSha256": report["maintainedSourceAfterSha256"]}))


if __name__ == "__main__":
    main()
