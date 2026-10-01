"""Fixed validation image/context ablations of selected V3 bytes, no optimization."""
import hashlib
import json
from pathlib import Path
import sys
import numpy as np
import onnxruntime as ort
from PIL import Image

sys.path.insert(0, "learner")
from recorded import nearest_image

directory = Path(sys.argv[1]).resolve()
selection = json.loads((directory / "selection.json").read_text())
rows = json.loads((directory / "validation-manifest.json").read_text())["rows"]
images = []
for row in rows:
    if hashlib.sha256(Path(row["image"]).read_bytes()).hexdigest() != row["sourceImage"]:
        raise ValueError("Validation BEFORE PNG changed")
    with Image.open(row["image"]) as image:
        images.append(np.asarray(nearest_image(image), dtype=np.float32).transpose(2,0,1) / 255)
truths = np.asarray([row["predicate_labels"] for row in rows])
reports = []
for candidate in selection["candidateHashes"]:
    path = directory / "models" / str(candidate["seed"]) / "trained.onnx"
    if hashlib.sha256(path.read_bytes()).hexdigest() != candidate["sha256"]:
        raise ValueError("Selected visual candidate changed")
    options = ort.SessionOptions(); options.intra_op_num_threads = 2
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"], sess_options=options)
    measurements = {}
    for condition in ["normal", "image_zero", "context_zero", "both_zero"]:
        predictions = []
        for row, image in zip(rows, images):
            history = np.asarray(row["history"], dtype=np.float32)[None]
            history[:,2,:8] = 0; history[:,3,:8] = 0; history[:,3,9:11] = 0; history[:,3,11] = -1
            if condition in ["context_zero", "both_zero"]:
                history = np.zeros_like(history); history[:,3,11] = -1
            captured = np.zeros_like(image) if condition in ["image_zero", "both_zero"] else image
            values = session.run(None, {"image": captured[None], "history": history,
                "candidates": np.asarray(row["candidates"],dtype=np.float32)[None]})
            predictions.append(values[1][0] >= 0)
        known = truths >= 0
        measurements[condition] = {"predicateAccuracy": float((np.asarray(predictions) == truths)[known].mean()), "knownLabels": int(known.sum())}
    reports.append({**candidate, "conditions": measurements, "imageBenefit": measurements["normal"]["predicateAccuracy"] - measurements["image_zero"]["predicateAccuracy"]})
report = {"schemaVersion":1,"level":"Selected-checkpoint validation ablation; not final qualification",
    "selectionSha256":hashlib.sha256((directory / "selection.json").read_bytes()).hexdigest(),
    "validationManifestSha256":hashlib.sha256((directory / "validation-manifest.json").read_bytes()).hexdigest(),"models":reports}
with (directory / "development-visual-ablation.json").open("x") as output:
    json.dump(report,output,indent=2)
print(json.dumps(report))
