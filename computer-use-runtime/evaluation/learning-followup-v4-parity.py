"""Validate conditional-head and variable-candidate export without retraining."""
import hashlib
import json
from pathlib import Path
import sys
import numpy as np
from PIL import Image
import onnxruntime as ort
import torch

sys.path.insert(0,"learner")
from model_v4 import Controller
from recorded import nearest_image
torch.set_num_threads(2)
directory=Path(sys.argv[1]).resolve()
rows=json.loads((directory/"validation-manifest.json").read_text())["rows"]
indices=np.linspace(0,len(rows)-1,16,dtype=int)
selection=json.loads((directory/"selection.json").read_text())
reports=[]
for candidate in selection["candidateHashes"]:
    folder=directory/"models"/str(candidate["seed"])
    if hashlib.sha256((folder/"trained.onnx").read_bytes()).hexdigest()!=candidate["sha256"]:
        raise ValueError("Selected ONNX bytes changed")
    model=Controller();model.load_state_dict(torch.load(folder/"trained.pt",weights_only=True));model.eval()
    options=ort.SessionOptions();options.intra_op_num_threads=2
    session=ort.InferenceSession(str(folder/"trained.onnx"),providers=["CPUExecutionProvider"],sess_options=options)
    maximum=0
    for index in indices:
        row=rows[int(index)]
        with Image.open(row["image"]) as pixels:
            pixels=nearest_image(pixels)
            image=np.asarray(pixels,dtype=np.float32).transpose(2,0,1)[None]/255
        for mode in ["selection","state","forecast"]:
            history=np.asarray(row["history"],dtype=np.float32)[None];history[:,3,:8]=0;history[:,3,9:11]=0;history[:,3,11]=-1
            if mode=="state":history[:,2,:8]=0
            if mode=="forecast":history[:,3,:8]=row["proposedDescriptor"]
            for count in [1,2,3,4,8,9]:
                candidates=np.asarray(row["candidates"][:count],dtype=np.float32)[None]
                feed={"image":image,"history":history,"candidates":candidates}
                with torch.no_grad(): expected=model(*(torch.tensor(feed[key]) for key in ["image","history","candidates"]))
                actual=session.run(None,feed)
                maximum=max(maximum,max(float(np.max(np.abs(a.detach().numpy()-b))) for a,b in zip(expected,actual)))
    reports.append({**candidate,"contexts":16,"candidateCounts":[1,2,3,4,8,9],"outputs":["scores","predicates","recovery","outcome"],"forwards":["selection","state","forecast"],"maximumError":maximum})
with (directory/"conditional-parity.json").open("x") as output:json.dump({"models":reports,"selectionSha256":hashlib.sha256((directory/"selection.json").read_bytes()).hexdigest()},output,indent=2)
print(json.dumps(reports))
