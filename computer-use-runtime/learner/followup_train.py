"""CPU-only followup candidates. Training never reads the final evaluation store."""
import hashlib
import json
import pathlib
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image
import torch
from model import Controller
from metrics import require_known_labels

torch.set_num_threads(2)
root = pathlib.Path(sys.argv[1]).resolve()
protocol = json.loads((root / "protocol.json").read_text())
track = sys.argv[2]
source = root / track
train = json.loads((source / "train-manifest.json").read_text())["rows"]
validation = json.loads((source / "validation-manifest.json").read_text())["rows"]
if set(row["session"] for row in train) & set(row["session"] for row in validation):
    raise ValueError("Whole training and validation sessions overlap")


def tensors(rows):
    pixels = np.stack([np.asarray(Image.open(row["image"]), dtype=np.float32).transpose(2, 0, 1) / 255 for row in rows])
    return (torch.tensor(pixels), torch.tensor([row["history"] for row in rows],dtype=torch.float32), torch.tensor([row["candidates"] for row in rows],dtype=torch.float32), torch.tensor([row["teacher_choice"] for row in rows],dtype=torch.long))


image, history, candidates, labels = tensors(train)
if not (labels >= 0).any():
    raise ValueError("No independently verified selection labels in development data")
v = tensors(validation)
require_known_labels(validation_selection=v[3] >= 0)
reports = []
for seed in protocol["seeds"]:
    torch.manual_seed(seed)
    model = Controller()
    folder = source / "models" / str(seed)
    folder.mkdir(parents=True, exist_ok=False)
    initial = {key: value.clone() for key, value in model.state_dict().items()}
    torch.save(initial, folder / "initialized.pt")
    sample = (image[:1], history[:1], candidates[:1])

    def export(name):
        model.eval()
        torch.onnx.export(model, sample, str(folder / (name + ".onnx")), input_names=["image", "history", "candidates"], output_names=["scores", "predicates", "recovery", "outcome"], dynamic_axes={"candidates": {1: "candidate_count"}, "scores": {1: "candidate_count"}}, opset_version=17, dynamo=False)

    export("initialized")
    optimizer = torch.optim.AdamW(model.parameters(), lr=protocol["training"]["learningRate"])
    losses = []
    updates = 0
    start = time.perf_counter()
    for epoch in range(protocol["training"]["epochs"]):
        model.train()
        total = 0
        for ids in torch.randperm(len(train)).split(64):
            scores, _, _, _ = model(image[ids], history[ids], candidates[ids])
            known = labels[ids] >= 0
            loss = torch.nn.functional.cross_entropy(scores[known], labels[ids][known]) if known.any() else scores.sum() * 0
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total += float(loss.detach()) * len(ids)
            updates += 1
        losses.append(total / len(train))
    training_seconds = time.perf_counter() - start
    model.eval()
    torch.save(model.state_dict(), folder / "trained.pt")
    export("trained")
    reloaded = Controller()
    reloaded.load_state_dict(torch.load(folder / "trained.pt", weights_only=True))
    reloaded.eval()
    with torch.no_grad():
        expected = model(*sample)
        actual_reload = reloaded(*sample)
        valid = v[3] >= 0
        accuracy = float((model(*v[:3])[0].argmax(1)[valid] == v[3][valid]).float().mean())
    session = ort.InferenceSession(str(folder / "trained.onnx"), providers=["CPUExecutionProvider"], sess_options=ort.SessionOptions())
    actual = session.run(None, {key: value.numpy() for key, value in zip(["image", "history", "candidates"], sample)})
    report = {"seed": seed, "parameters": sum(parameter.numel() for parameter in model.parameters()), "frozenParameters": 0, "contextVersion": 2, "trainingSeconds": training_seconds, "losses": losses, "updates": updates, "validationAccuracy": accuracy, "reloadMaxError": max(float((a-b).abs().max()) for a,b in zip(expected, actual_reload)), "onnxMaxError": max(float(np.max(np.abs(a.detach().numpy()-b))) for a,b in zip(expected, actual)), "parameterUpdateL2": float(sum((value-initial[key]).square().sum() for key,value in model.state_dict().items()).sqrt()), "sha256": hashlib.sha256((folder / "trained.onnx").read_bytes()).hexdigest(), "checkpointBytes": (folder / "trained.pt").stat().st_size, "onnxBytes": (folder / "trained.onnx").stat().st_size, "trainSessionCount": len(set(row["session"] for row in train)), "validationSessionCount": len(set(row["session"] for row in validation)), "dataSource": "actual recorded pre-action " + track + " screenshots and task/history context", "policyUsesPostActionData": False, "device": "cpu", "trainManifestHash": hashlib.sha256((source / "train-manifest.json").read_bytes()).hexdigest(), "validationManifestHash": hashlib.sha256((source / "validation-manifest.json").read_bytes()).hexdigest()}
    (folder / "report.json").write_text(json.dumps(report, indent=2))
    reports.append(report)
    print(json.dumps({key: value for key, value in report.items() if key != "losses"}), flush=True)
(source / "training.json").write_text(json.dumps(reports, indent=2))
