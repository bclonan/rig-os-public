"""Read-only development lineage review. This is not a final qualification."""
import base64
from collections import Counter
import datetime
import hashlib
import io
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, "learner")
from recorded import nearest_image

identity_spec = importlib.util.spec_from_file_location("review_source_identity", "scripts/source-identity.py")
identity_module = importlib.util.module_from_spec(identity_spec)
identity_spec.loader.exec_module(identity_module)
source_identity = identity_module.source_identity


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


root = Path.cwd().resolve()
directory = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root / "evidence/learning-followup-v2/browser"
selection = json.loads((directory / "selection.json").read_text())
protocol = json.loads((directory.parent / "protocol.json").read_text())
if selection["status"] != "PASS" or selection["protocolHash"] != digest(directory.parent / "protocol.json"):
    raise ValueError("Selected development candidate/protocol mismatch")

splits = {}
all_groups = []
for split in ["train", "validation"]:
    manifest = json.loads((directory / (split + "-manifest.json")).read_text())
    old_directory = root / "evidence/learning-followup-v1/browser"
    old_bundle = json.loads((old_directory / (split + "-bundle.json")).read_text())
    old_hash = digest(old_directory / (split + "-manifest.json"))
    if old_hash != manifest["originalManifestHash"]:
        raise ValueError("Original positive manifest changed")
    old_demos = {demo["session"]: demo for demo in old_bundle["demonstrations"]}
    database = directory / (split + "-store/runtime.sqlite")
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as store:
        runs = {key: json.loads(body) for key, body in store.execute("SELECT id,body FROM runs")}
        events = [{"runId": run_id, "type": kind, "data": json.loads(data)} for run_id, kind, data in store.execute("SELECT run_id,type,data FROM events ORDER BY seq")]
    abstained_runs = {event["runId"] for event in events if event["type"] == "learning_abstention"}
    before_observations = {}
    for event in events:
        data = event["data"]
        if event["type"] in ["experience", "learning_clarification_observation", "learning_abstention", "learning_independent_label"] and "before" in data:
            before_observations[data["before"]["id"]] = data["before"]
    counts = Counter()
    for row in manifest["rows"]:
        counts["rows"] += 1
        counts["positiveSelection"] += row["teacher_choice"] >= 0
        counts["clarification"] += row["recovery"] == 3
        counts["knownOutcomes"] += row["outcome_mask"][0] == 1
        counts["unknownOutcomes"] += row["outcome_mask"][0] == 0
        counts["knownCosts"] += row["outcome_mask"][1] == 1
        counts["unknownCosts"] += row["outcome_mask"][1] == 0
        if row["policyUsesPostActionData"] is not False or len(row["history"]) != 4 or any(row["history"][3][:8]):
            raise ValueError("Selection receives a proposal or post-action data")
        if row.get("sourceManifestHash"):
            counts["preservedPositiveRows"] += 1
            if row["sourceManifestHash"] != old_hash:
                raise ValueError("Preserved positive row has another manifest")
            demo = old_demos[row["session"]]
            step = next(step for step in demo["steps"] if step["before"]["image"] == row["sourceImage"])
            before = step["before"]
            source_bytes = base64.b64decode(old_bundle["artifacts"][row["sourceImage"]], validate=True)
            final_facts = demo["steps"][-1]["after"]["facts"]
            if not demo["verified"] or not all(final_facts.get(key) == answer for key, answer in demo["contract"]["expected"].items()):
                raise ValueError("Preserved positive has no independently reached expected output")
        else:
            counts["newActualRows"] += 1
            run = runs[row["taskId"]]
            if run["contract"]["requester"] != row["requester"]:
                raise ValueError("New row belongs to another requester")
            uncertain_run = run["status"] in ["uncertain", "reconciliation_required"] or run["bindings"].get("cleanupFailed", False)
            counts["positiveSelectionOnUncertainRun"] += uncertain_run and row["teacher_choice"] >= 0
            counts["knownCostOnUncertainRun"] += uncertain_run and row["outcome_mask"][1] == 1
            counts["unknownCostOnUncertainRun"] += uncertain_run and row["outcome_mask"][1] == 0
            before = before_observations.get(row["observationId"])
            source_bytes = Path(row["image"]).read_bytes()
            counts["journalBoundBeforeRows"] += before is not None
            counts["beforeNotStoredInJournal"] += before is None
            counts["unmatchedBeforeOnUncertainRun"] += before is None and uncertain_run
            counts["unmatchedBeforeOnAbstentionRun"] += before is None and row["taskId"] in abstained_runs
        if hashlib.sha256(source_bytes).hexdigest() != row["sourceImage"]:
            raise ValueError("Actual BEFORE PNG bytes changed")
        if before is not None:
            truths = [int(before["facts"][key]) if isinstance(before["facts"].get(key), bool) else -1 for key in ["ready", "closed", "dialog"]]
            if row["predicate_labels"] != truths or before["image"] != row["sourceImage"]:
                raise ValueError("Predicate targets differ from recorded BEFORE facts")
        with Image.open(io.BytesIO(source_bytes)) as source:
            actual = np.asarray(nearest_image(source, None if row.get("imageIsFullCapture") else row["crop"]))
        with Image.open(row["image"]) as retained:
            measured = np.asarray(nearest_image(retained)) if row.get("imageIsFullCapture") else np.asarray(retained.convert("RGB")) if row.get("sourceManifestHash") else np.asarray(nearest_image(retained, row["crop"]))
        if not np.array_equal(actual, measured):
            raise ValueError("Training crop differs from actual captured BEFORE pixels")
    groups = set(row["session"] for row in manifest["rows"])
    required = protocol["trainingSessions" if split == "train" else "validationSessions"]
    if len(groups) != required or manifest["groups"] != required:
        raise ValueError("Whole session count differs from frozen protocol")
    all_groups.append(groups)
    statuses = Counter(run["status"] for run in runs.values())
    receipt_phases = Counter(event["data"].get("receipt", {}).get("phase", "missing") for event in events if event["type"] == "experience")
    splits[split] = {"manifestSha256": digest(directory / (split + "-manifest.json")), "wholeGroups": len(groups), "runtimeStatuses": dict(statuses), "receiptPhases": dict(receipt_phases), **counts}
if all_groups[0] & all_groups[1]:
    raise ValueError("Whole training/validation groups overlap")

training = json.loads((directory / "training.json").read_text())
models = []
for report in training:
    folder = directory / "models" / str(report["seed"])
    actual = digest(folder / "trained.onnx")
    selected = next(candidate["sha256"] for candidate in selection["candidateHashes"] if candidate["seed"] == report["seed"])
    if actual != selected or actual != report["sha256"]:
        raise ValueError("Model report/selection/artifact SHA mismatch")
    if any(report[key] != splits[split]["manifestSha256"] for key, split in [("trainManifestHash", "train"), ("validationManifestHash", "validation")]):
        raise ValueError("Model optimized another dataset")
    models.append({key: report[key] for key in ["seed", "sha256", "parameters", "parameterUpdateL2", "headUpdateL2", "reloadMaxError", "onnxMaxError", "validationHeads", "trainingSeconds", "peakProcessRamBytes"]})

identity = source_identity(root)
owned_files = [file for file in identity["files"] if file["path"].startswith(("src/learner/", "learner/", "evaluation/learning-followup", "tests/learning-context"))]
report = {
    "schemaVersion": 1, "status": "PASS", "evidenceLevel": "Development lineage and integrity review, not final deployment qualification",
    "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "protocolSha256": selection["protocolHash"], "namespace": protocol["id"],
    "selectionSha256": digest(directory / "selection.json"), "splits": splits, "models": models,
    "operational": json.loads((directory / "operational.json").read_text()),
    "conditionalParity": json.loads((directory / "conditional-parity.json").read_text()),
    "sourceIdentity": identity, "ownedFileReviewInventory": owned_files,
    "boundaries": [
        "V3 state/recovery forwards hide public state values, goal tokens, expected-key hints and proposed descriptor. Full captured target PNGs supply visual input." if protocol["contextVersion"] == 4 else "Current public ready/closed/dialog facts accompany pixels. This is not pixel-only predicate discovery.",
        "Training correction targets use real reached fixture effects. Missing typed fields produce actual awaiting_input rows with masked effects.",
        "V1 browser conversion optimized400/80whole sessions. V2 uses600/120exact groups, including newly reached corrections and clarification.",
        "Some no-experience failures/abstentions retain captured BEFORE bytes without their full BEFORE observation in the journal. Counters report exact coverage by status. Those labels have collector provenance, not independent journal reconstruction.",
        "V2 used the v1 initialized17artifact path without separately prefrozen hash. V3 freezes its reaching-policy SHA before collection. No retroactive V2pre-attestation is claimed.",
        "Final heldout outcomes remain unread until the integrated source freezes. This report cannot activate a candidate.",
        "Native v1 trains selection only in the owned Windows disposable editor. V2 full-head scope remains browser only.",
    ],
}
destination = root / "evidence" / ("learning-followup-review-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ".json")
with destination.open("x") as output:
    json.dump(report, output, indent=2)
print(json.dumps({"path": str(destination), "status": report["status"], "splits": splits, "models": [{"seed": model["seed"], "sha256": model["sha256"], "peakProcessRamBytes": model["peakProcessRamBytes"]} for model in models], "ownedFiles": len(owned_files)}))
