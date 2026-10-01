"""Candidate-only rows from actual BEFORE screenshots and earlier delivered input.

Native recordings train descriptor-based method selection when a bundle supplies
its skill descriptors. Unmapped native runs remain visual/negative examples and
never receive an invented positive action label.
"""
import base64
import hashlib
import io
import json
import pathlib
import re

import numpy as np
from PIL import Image
from generate import DESCRIPTORS

CONTEXT_VERSION = 2
OPERATIONS = ["fill", "click", "key", "scroll", "drag", "hold", "observe"]


def goal_vector(goal):
    vector = np.zeros(8, dtype=np.float32)
    for word in re.findall(r"[^\W]+", goal.lower(), flags=re.UNICODE)[:256]:
        value = 2166136261
        for byte in word.encode("utf-8"):
            value = ((value ^ byte) * 16777619) & 0xFFFFFFFF
        vector[value % 8] += 1 if value & 256 else -1
    return vector / max(float(np.linalg.norm(vector)), 1.0)


def context(task, before, previous, start_at):
    history = np.zeros((3, 12), dtype=np.float32)
    previous = [entry for entry in previous if entry["after"]["at"] <= before["at"] and entry["action"]["requester"] == task["requester"] and all(entry["action"][key] == before[key] for key in ["host", "session", "target"])]
    prior = previous[-2:]
    for index, entry in enumerate(prior):
        row = history[2 - len(prior) + index]
        action = entry["action"]
        operation = action["operation"]
        row[OPERATIONS.index(operation) if operation in OPERATIONS else 7] = 1
        row[8] = 1
        row[9] = np.clip((action["deadline"] - before["at"]) / task["budgets"]["deadlineMs"], 0, 1)
        row[10] = action["scope"] in task["effects"]
        row[11] = 1
    history[-1, :8] = goal_vector(task["goal"])
    history[-1, 8] = min(1, len(task["effects"]) / 32)
    history[-1, 9] = max(0, 1 - sum(entry["action"]["runId"] == task["id"] for entry in previous) / task["budgets"]["steps"])
    history[-1, 10] = max(0, 1 - max(0, before["at"] - start_at) / task["budgets"]["deadlineMs"])
    facts = list(before["facts"].values())
    history[-1, 11] = sum(isinstance(value, bool) for value in facts) / len(facts) if facts else 0
    return history


def nearest_image(image, crop=None):
    region = crop or (0, 0, image.width, image.height)
    x, y, right, bottom = region
    if min(x, y) < 0 or right > image.width or bottom > image.height or x >= right or y >= bottom:
        raise ValueError("Learning crop escapes the captured target")
    array = np.asarray(image.convert("RGB"))
    xs = x + np.floor((np.arange(32) + .5) * (right - x) / 32).astype(int)
    ys = y + np.floor((np.arange(32) + .5) * (bottom - y) / 32).astype(int)
    return Image.fromarray(array[ys[:, None], xs[None, :]])


def load_bundle(path, output):
    encoded = pathlib.Path(path).read_bytes()
    bundle = json.loads(encoded)
    if bundle.get("schemaVersion") != 1 or bundle.get("kind") != "experience-bundle":
        raise ValueError("Unsupported experience bundle")
    if bundle.get("privacy", {}).get("mode") == "redacted":
        raise ValueError("Redacted exports cannot train visual policies; use authorized private fixture data")
    folder = pathlib.Path(output) / "recorded-images"
    folder.mkdir(parents=True, exist_ok=True)
    rows = []
    counts = {"positive": 0, "failureOrUnknown": 0, "corrected": 0, "skipped": 0, "native": 0}
    descriptors = bundle.get("skills", [])
    if len(descriptors) > 1024 or any(len(skill.get("descriptor", [])) != 8 or not np.isfinite(skill["descriptor"]).all() for skill in descriptors):
        raise ValueError("Invalid recorded candidate descriptors")
    for demo in bundle["demonstrations"]:
        previous = []
        task = demo["contract"]
        start_at = demo["steps"][0]["before"]["at"] if demo["steps"] else 0
        native = task["target"]["identity"] != "browser-fixture-v1"
        candidates = [skill["descriptor"] for skill in descriptors] if native and descriptors else DESCRIPTORS.tolist()
        if not candidates:
            raise ValueError("Recorded training requires candidate descriptors")
        for index, step in enumerate(demo["steps"]):
            before, action, receipt, after = (step[key] for key in ["before", "action", "receipt", "after"])
            if action["runId"] != demo["session"] or receipt["actionId"] != action["id"] or action["target"] != before["target"] or action["host"] != before["host"] or action["session"] != before["session"]:
                raise ValueError("Recorded action is not bound to its session and BEFORE observation")
            key = before.get("image")
            if key not in bundle["artifacts"]:
                raise ValueError("Recorded BEFORE image missing")
            raw = base64.b64decode(bundle["artifacts"][key], validate=True)
            if len(raw) > 16 * 1024 * 1024 or hashlib.sha256(raw).hexdigest() != key:
                raise ValueError("Recorded image hash or budget mismatch")
            with Image.open(io.BytesIO(raw)) as image:
                if image.width > 8192 or image.height > 8192 or image.width * image.height > 16 * 1024 * 1024:
                    raise ValueError("Recorded image dimensions exceed budget")
                crop = [0, 0, image.width, image.height]
                if not native:
                    color = np.rint(np.array(before["features"][:3]) * 255).astype(np.int16)
                    if len(color) != 3:
                        counts["skipped"] += 1
                        continue
                    array = np.asarray(image.convert("RGB"))
                    ys, xs = np.where(np.max(np.abs(array.astype(np.int16) - color), axis=2) <= 2)
                    if len(xs) < 64 or xs.max() - xs.min() > 100 or ys.max() - ys.min() > 100:
                        counts["skipped"] += 1
                        continue
                    crop = [int(xs.min()), int(ys.min()), int(xs.max() + 1), int(ys.max() + 1)]
                resized = nearest_image(image, crop)
            image_path = folder / (hashlib.sha256(demo["session"].encode()).hexdigest() + "-" + str(index) + ".png")
            resized.save(image_path)
            corrections = [correction for correction in demo.get("corrections", []) if correction["step"] == index]
            blocked = bool(corrections) or not demo["verified"] or step["label"] != "verified"
            if native:
                choice = next((i for i, skill in enumerate(descriptors) if skill["id"] == task.get("method")), -100)
                blocked = blocked or choice < 0
                counts["native"] += 1
            else:
                locator = action["args"].get("locator", "")
                choice = 1 if locator == "open" else 2 if locator == "dismiss" else 0
            counts["corrected"] += bool(corrections)
            counts["failureOrUnknown" if blocked else "positive"] += 1
            history = context(task, before, previous, start_at)
            labels = [float(before["facts"][key]) if isinstance(before["facts"].get(key), bool) else -1 for key in ["ready", "closed", "dialog"]]
            outcome_known = (bool(demo["verified"]) and not blocked) or any(correction["label"] == "failure" for correction in corrections)
            rows.append({"session": demo["session"], "family": "recorded-native" if native else "recorded-controlled-form", "image": str(image_path), "history": history.tolist(), "candidates": candidates, "teacher_choice": -100 if blocked else choice, "predicate_labels": labels, "recovery": 3 if blocked else min(choice, 3), "success_cost": [float(not blocked), min(1, (index + 1) / task["budgets"]["steps"])], "outcome_mask": [float(outcome_known), 1.0], "source": "actual pre-action nonbrowser target screenshot" if native else "actual pre-action screenshot crop from controlled browser", "sourceImage": key, "crop": crop, "corrections": corrections, "contextVersion": CONTEXT_VERSION, "policyUsesPostActionData": False, "historyActionIds": [entry["action"]["id"] for entry in previous[-2:]], "candidateDescriptorSource": "bundle skill descriptors" if native else "controlled form role descriptors"})
            if receipt["phase"] in ["acknowledged", "effect_verified"]:
                if after["at"] < before["at"]:
                    raise ValueError("Recorded AFTER observation precedes its BEFORE observation")
                previous.append(step)
    manifest = {"sourceBundleSha256": hashlib.sha256(encoded).hexdigest(), "counts": counts, "contextVersion": CONTEXT_VERSION, "rows": rows}
    (pathlib.Path(output) / "recorded-manifest.json").write_text(json.dumps(manifest, indent=2))
    return rows
