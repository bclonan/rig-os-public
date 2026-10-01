"""Operational measurements of selected candidate bytes, without retraining."""
import ctypes
import hashlib
import json
import os
from pathlib import Path
import sys
import time

import numpy as np
import onnxruntime as ort
from PIL import Image

directory = Path(sys.argv[1]).resolve()
selection = json.loads((directory / "selection.json").read_text())
if selection["status"] != "PASS":
    raise ValueError("Only a validation-selected checkpoint may be measured")
row = json.loads((directory / "validation-manifest.json").read_text())["rows"][0]
sys.path.insert(0, "learner")
from recorded import nearest_image
with Image.open(row["image"]) as pixels:
    pixels = nearest_image(pixels) if row.get("imageIsFullCapture") else nearest_image(pixels, row.get("crop")) if row.get("crop") and not row.get("sourceManifestHash") else pixels.convert("RGB")
    image = np.asarray(pixels, dtype=np.float32).transpose(2,0,1)[None] / 255
feed = {"image": image,
        "history": np.asarray(row["history"], dtype=np.float32)[None],
        "candidates": np.asarray(row["candidates"], dtype=np.float32)[None]}
reports = []
for candidate in selection["candidateHashes"]:
    path = directory / "models" / str(candidate["seed"]) / "trained.onnx"
    if hashlib.sha256(path.read_bytes()).hexdigest() != candidate["sha256"]:
        raise ValueError("Selected checkpoint changed before operational measurement")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"], sess_options=options)
    def predict():
        values = session.run(None,feed)
        if feed["history"].shape[1] == 4:
            conditioned = feed["history"].copy()
            conditioned[:,3,:8] = feed["candidates"][0,int(values[0][0].argmax())]
            session.run(None,{**feed,"history":conditioned})
            if feed["history"][0,3,11] == -1:
                state = feed["history"].copy(); state[:,2,:8] = 0; state[:,3,:8] = 0; state[:,3,9:11] = 0
                session.run(None,{**feed,"history":state})
    for _ in range(10):
        predict()
    times = []
    for _ in range(100):
        start = time.perf_counter()
        predict()
        times.append((time.perf_counter() - start) * 1000)
    reports.append({**candidate, "inferenceMsMedian": float(np.median(times)),
                    "inferenceMsP95": float(np.quantile(times, .95)), "samples": 100})

if os.name == "nt":
    class MEM(ctypes.Structure):
        _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                    ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
    ctypes.windll.kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
    memory = MEM()
    memory.cb = ctypes.sizeof(memory)
    if not ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(memory), memory.cb):
        raise RuntimeError("Process RAM measurement failed")
    peak_ram = memory.PeakWorkingSetSize
else:
    import resource
    peak_ram = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)

full_heads = feed["history"].shape[1] == 4
report = {"schemaVersion": 1, "models": reports, "device": "CPUExecutionProvider", "threads": 2,
          "peakProcessRamBytes": peak_ram, "ramScope": "Separate candidate inference process, including Python and ORT",
          "learnedCapabilities": ["selection", "predicates", "recovery", "clarification", "outcome_cost"] if full_heads else ["selection"],
          "untrainedHeads": [] if full_heads else ["predicates", "recovery", "outcome"],
          "inferencePasses": 3 if full_heads and feed["history"][0,3,11] == -1 else 2 if full_heads else 1,
          "selectionSha256": hashlib.sha256((directory / "selection.json").read_bytes()).hexdigest(),
          "policyUsesPostActionData": False}
with (directory / "operational.json").open("x") as output:
    json.dump(report, output, indent=2)
print(json.dumps(report))
