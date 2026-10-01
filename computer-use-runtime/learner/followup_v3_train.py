"""Train all advisory heads from actual BEFORE observations and masked targets."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import numpy as np
from PIL import Image
import onnxruntime as ort
import torch
from model import Controller
from recorded import nearest_image
from metrics import require_known_labels

torch.set_num_threads(2)
root = Path(sys.argv[1]).resolve()
protocol = json.loads((root / "protocol.json").read_text())
source = root / "browser"
training = json.loads((source / "train-manifest.json").read_text())["rows"]
validation = json.loads((source / "validation-manifest.json").read_text())["rows"]
if set(row["session"] for row in training) & set(row["session"] for row in validation):
    raise ValueError("Whole v2 training/validation groups overlap")

def tensors(rows):
    images = []
    for row in rows:
        if hashlib.sha256(Path(row["image"]).read_bytes()).hexdigest() != row["sourceImage"]:
            raise ValueError("Actual full BEFORE image bytes changed")
        with Image.open(row["image"]) as image:
            # V1 manifest images are already cropped. Its crop records source
            # coordinates, while new v2 image paths reference the full capture.
            image = nearest_image(image)
            images.append(np.asarray(image, dtype=np.float32).transpose(2,0,1) / 255)
    history = np.asarray([row["history"] for row in rows], dtype=np.float32)
    history[:,3,:8] = 0
    history[:,3,9:11] = 0
    history[:,3,11] = -1
    return tuple(torch.tensor(value) for value in [np.stack(images), history,
        np.asarray([row["candidates"] for row in rows],dtype=np.float32), np.asarray([row["teacher_choice"] for row in rows],dtype=np.int64),
        np.asarray([row["predicate_labels"] for row in rows],dtype=np.float32), np.asarray([row["recovery"] for row in rows],dtype=np.int64),
        np.asarray([row["success_cost"] for row in rows],dtype=np.float32), np.asarray([row["outcome_mask"] for row in rows],dtype=np.float32),
        np.asarray([row["proposedDescriptor"] for row in rows],dtype=np.float32)])

def measure(model, values):
    image, history, candidates, choice, truth, recovery, outcome, masks, proposed = values
    conditioned = history.clone(); conditioned[:,3,:8] = proposed
    state = history.clone(); state[:,2,:8] = 0
    with torch.no_grad():
        scores = model(image,history,candidates)[0]
        _, predicates, advice, _ = model(image,state,candidates)
        forecast = model(image,conditioned,candidates)[3]
        known_choice = choice >= 0; known_predicate = truth >= 0; clarify = recovery == 3
        known_outcome = masks[:,0] > 0; known_cost = masks[:,1] > 0
        require_known_labels(selection=known_choice, predicates=known_predicate, clarification=clarify, outcome=known_outcome, cost=known_cost)
        return {"selectionAccuracy": float((scores.argmax(1)[known_choice] == choice[known_choice]).float().mean()),
          "predicateAccuracy": float(((predicates > 0) == (truth > .5))[known_predicate].float().mean()),
          "recoveryAccuracy": float((advice.argmax(1) == recovery).float().mean()),
          "clarificationRecall": float((advice.argmax(1)[clarify] == 3).float().mean()),
          "outcomeBrier": float((forecast[:,0][known_outcome] - outcome[:,0][known_outcome]).square().mean()),
          "costMae": float((forecast[:,1][known_cost] - outcome[:,1][known_cost]).abs().mean()),
          "selectionLabels": int(known_choice.sum()), "predicateLabels": int(known_predicate.sum()),
          "clarificationLabels": int(clarify.sum()), "knownOutcomeLabels": int(known_outcome.sum()), "knownCostLabels": int(known_cost.sum())}

values = tensors(training); valid_values = tensors(validation); reports = []
for seed in protocol["seeds"]:
    torch.manual_seed(seed); model = Controller(); initial = {key:value.clone() for key,value in model.state_dict().items()}
    folder = source / "models" / str(seed); folder.mkdir(parents=True,exist_ok=False)
    torch.save(initial,folder / "initialized.pt"); sample = tuple(value[:1] for value in values[:3])
    def export(name):
        model.eval(); torch.onnx.export(model,sample,str(folder / (name + ".onnx")),input_names=["image","history","candidates"],output_names=["scores","predicates","recovery","outcome"],
            dynamic_axes={"candidates":{1:"candidate_count"},"scores":{1:"candidate_count"}},opset_version=17,dynamo=False)
    initialized_metrics = measure(model,valid_values); export("initialized")
    optimizer = torch.optim.AdamW(model.parameters(),lr=protocol["training"]["learningRate"])
    losses = []; start = time.perf_counter(); updates = 0
    for epoch in range(protocol["training"]["epochs"]):
        model.train(); total = 0
        for ids in torch.randperm(len(training)).split(64):
            image,history,candidates,choice,truth,recovery,outcome,masks,proposed = [value[ids] for value in values]
            conditioned = history.clone(); conditioned[:,3,:8] = proposed
            state = history.clone(); state[:,2,:8] = 0
            scores = model(image,history,candidates)[0]; _, predicates, advice, _ = model(image,state,candidates); forecast = model(image,conditioned,candidates)[3]
            known = choice >= 0; predicate_mask = truth >= 0
            selection_loss = torch.nn.functional.cross_entropy(scores[known],choice[known]) if known.any() else scores.sum()*0
            predicate_loss = (torch.nn.functional.binary_cross_entropy_with_logits(predicates,truth.clamp(0,1),reduction="none") * predicate_mask).sum() / predicate_mask.sum().clamp_min(1)
            recovery_loss = torch.nn.functional.cross_entropy(advice,recovery)
            outcome_loss = ((forecast-outcome).square()*masks).sum() / masks.sum().clamp_min(1)
            loss = selection_loss + .25*predicate_loss + .2*recovery_loss + .2*outcome_loss
            optimizer.zero_grad(); loss.backward(); optimizer.step(); updates += 1; total += float(loss.detach())*len(ids)
        losses.append(total/len(training))
    training_seconds = time.perf_counter()-start; model.eval(); torch.save(model.state_dict(),folder / "trained.pt"); export("trained")
    reloaded = Controller(); reloaded.load_state_dict(torch.load(folder / "trained.pt",weights_only=True)); reloaded.eval()
    with torch.no_grad(): expected = model(*sample); actual_reload = reloaded(*sample)
    options = ort.SessionOptions(); options.intra_op_num_threads = 2; options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(folder / "trained.onnx"),providers=["CPUExecutionProvider"],sess_options=options)
    feed = {key:value.numpy() for key,value in zip(["image","history","candidates"],sample)}; actual = session.run(None,feed); times = []
    for _ in range(100):
        started = time.perf_counter(); session.run(None,feed); times.append((time.perf_counter()-started)*1000)
    metrics = measure(model,valid_values)
    report = {"seed":seed,"parameters":sum(value.numel() for value in model.parameters()),"frozenParameters":0,"contextVersion":4,"trainingSeconds":training_seconds,"losses":losses,"updates":updates,
      "validationAccuracy":metrics["selectionAccuracy"],"validationHeads":metrics,"initializedHeads":initialized_metrics,
      "reloadMaxError":max(float((a-b).abs().max()) for a,b in zip(expected,actual_reload)),"onnxMaxError":max(float(np.max(np.abs(a.detach().numpy()-b))) for a,b in zip(expected,actual)),
      "parameterUpdateL2":float(sum((value-initial[key]).square().sum() for key,value in model.state_dict().items()).sqrt()),
      "headUpdateL2":{head:float(sum((value-initial[key]).square().sum() for key,value in model.state_dict().items() if key.startswith(head+".")).sqrt()) for head in ["query","predicate","recovery","outcome"]},
      "sha256":hashlib.sha256((folder / "trained.onnx").read_bytes()).hexdigest(),"inferenceMsMedian":float(np.median(times)),"inferenceMsP95":float(np.quantile(times,.95)),
      "checkpointBytes":(folder / "trained.pt").stat().st_size,"onnxBytes":(folder / "trained.onnx").stat().st_size,"trainSessionCount":len(set(row["session"] for row in training)),"validationSessionCount":len(set(row["session"] for row in validation)),
      "policyUsesPostActionData":False,"policyUsesPublicStateTruth":False,"dataSource":"Actual full BEFORE screenshots, private state targets, independent effects and actual correction/clarification episodes",
      "trainManifestHash":hashlib.sha256((source / "train-manifest.json").read_bytes()).hexdigest(),"validationManifestHash":hashlib.sha256((source / "validation-manifest.json").read_bytes()).hexdigest(),
      "learnedCapabilities":["selection","predicates","recovery","clarification","outcome_cost"]}
    if os.name == "nt":
        class MEM(ctypes.Structure):
            _fields_=[("cb",ctypes.c_ulong),("PageFaultCount",ctypes.c_ulong),("PeakWorkingSetSize",ctypes.c_size_t),("WorkingSetSize",ctypes.c_size_t),("QuotaPeakPagedPoolUsage",ctypes.c_size_t),("QuotaPagedPoolUsage",ctypes.c_size_t),("QuotaPeakNonPagedPoolUsage",ctypes.c_size_t),("QuotaNonPagedPoolUsage",ctypes.c_size_t),("PagefileUsage",ctypes.c_size_t),("PeakPagefileUsage",ctypes.c_size_t)]
        ctypes.windll.kernel32.GetCurrentProcess.restype=ctypes.c_void_p; ctypes.windll.psapi.GetProcessMemoryInfo.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_ulong]
        memory=MEM(); memory.cb=ctypes.sizeof(memory)
        if not ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(),ctypes.byref(memory),memory.cb): raise RuntimeError("Training RAM measurement failed")
        report["peakProcessRamBytes"]=memory.PeakWorkingSetSize
    reports.append(report); (folder / "report.json").write_text(json.dumps(report,indent=2)); print(json.dumps({key:value for key,value in report.items() if key != "losses"}),flush=True)
(source / "training.json").write_text(json.dumps(reports,indent=2))
