"""Controlled visual fixture generator, not general real-desktop demonstrations.

Training images represent the workbench state indicator. The held-out browser
evaluator uses real rendered pixels and independent effect checks.
"""
import json,pathlib,random
import numpy as np
from PIL import Image

COLORS=[(53,168,102),(65,96,198),(222,117,48),(95,95,95)]
DESCRIPTORS=np.eye(8,dtype=np.float32)[:4]

def build(split,count,seed,root=pathlib.Path('datasets')):
    rng=random.Random(seed);out=root/split;out.mkdir(parents=True,exist_ok=True);records=[]
    for i in range(count):
        state=i%4
        rgb=np.zeros((32,32,3),dtype=np.uint8)
        noise=rng.randint(-5,5)
        rgb[:]=[max(0,min(255,c+noise)) for c in COLORS[state]]
        # Brightness and partial occlusion variations are independent of the label.
        if i%9==0:rgb[0:4,:]=240
        image=out/f'session-{seed}-{i}.png';Image.fromarray(rgb).save(image)
        history=np.zeros((3,12),dtype=np.float32);history[-1,0]=1;history[-1,8]=1;history[-1,9]=rng.random();history[-1,10]=i%2;history[-1,11]=1
        predicates=[float(state==j) for j in range(3)]
        if i%7==0:predicates[rng.randrange(3)]=-1
        records.append({'session':f'{split}-{seed}-{i}','family':f'{split}-parameter-family','image':str(image),'history':history.tolist(),'candidates':DESCRIPTORS.tolist(),'teacher_choice':state,'predicate_labels':predicates,'recovery':state,'success_cost':[float(state!=3),[.25,.5,.5,1][state]],'parameter':f'{split}-name-{seed}-{i}','source':'synthetic controlled visual workbench','interruption':i%19==0,'correction':'expert label for reached fixture state' if i%5==0 else None})
    (out/'manifest.json').write_text(json.dumps(records,indent=2))
    return records

if __name__=='__main__':
    build('train',600,811);build('validation',120,977)
    print('Generated 600 training and 120 validation sessions with PNG images.')
