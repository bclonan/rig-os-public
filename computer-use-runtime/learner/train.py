import json,pathlib,time,hashlib,os,random
import numpy as np
import torch
import onnxruntime as ort
from PIL import Image
from model import Controller
from generate import build

torch.set_num_threads(2)
root=pathlib.Path(os.environ.get('CUR_MODEL_DIR','models/candidate-'+str(int(time.time())) if pathlib.Path('evidence/audit-sealed.json').exists() else 'models'));root.mkdir(parents=True,exist_ok=True)
records=build('train',600,811);validation=build('validation',120,977)
recorded_count=0
if os.environ.get('CUR_DATASET_BUNDLE'):
    from recorded import load_bundle
    recorded=load_bundle(os.environ['CUR_DATASET_BUNDLE'],root);recorded_count=len(recorded);records+=recorded
def tensors(rows):
    images=np.stack([np.asarray(Image.open(r['image']),dtype=np.float32).transpose(2,0,1)/255 for r in rows])
    count=max(len(r['candidates']) for r in rows)
    padded=np.zeros((len(rows),count,8),dtype=np.float32);candidate_mask=np.zeros((len(rows),count),dtype=bool)
    for i,row in enumerate(rows):
        padded[i,:len(row['candidates'])]=row['candidates'];candidate_mask[i,:len(row['candidates'])]=True
    return (torch.tensor(images),torch.tensor([r['history'] for r in rows]),torch.tensor(padded),torch.tensor([r['teacher_choice'] for r in rows]),torch.tensor([r['predicate_labels'] for r in rows]),torch.tensor([r['recovery'] for r in rows]),torch.tensor([r['success_cost'] for r in rows]),torch.tensor([r.get('outcome_mask',[1.0,1.0]) for r in rows]),torch.tensor(candidate_mask))
image,history,candidates,label,predicates,recovery,outcome,outcome_mask,candidate_mask=tensors(records)
v=tensors(validation);reports=[]
for seed in [17,41,73]:
    torch.manual_seed(seed);np.random.seed(seed);random.seed(seed)
    model=Controller();folder=root/str(seed);folder.mkdir(exist_ok=True)
    initialized={k:v.clone() for k,v in model.state_dict().items()};torch.save(initialized,folder/'initialized.pt')
    sample=(image[:1],history[:1],candidates[:1]);losses=[]
    def export(name):
        model.eval()
        torch.onnx.export(model,sample,str(folder/(name+'.onnx')),input_names=['image','history','candidates'],output_names=['scores','predicates','recovery','outcome'],dynamic_axes={'candidates':{1:'candidate_count'},'scores':{1:'candidate_count'}},opset_version=17,dynamo=False)
    export('initialized')
    optimizer=torch.optim.AdamW(model.parameters(),lr=.008);start=time.perf_counter()
    for epoch in range(55):
        model.train();order=torch.randperm(len(records));total=0
        for ids in order.split(64):
            scores,p,r,o=model(image[ids],history[ids],candidates[ids]);scores=scores.masked_fill(~candidate_mask[ids],-1e9);mask=predicates[ids]>=0
            predicate_loss=torch.nn.functional.binary_cross_entropy_with_logits(p,predicates[ids].clamp(0,1),reduction='none')
            known=label[ids]>=0
            selection_loss=torch.nn.functional.cross_entropy(scores[known],label[ids][known]) if known.any() else scores.sum()*0
            outcome_loss=(torch.nn.functional.mse_loss(o,outcome[ids],reduction='none')*outcome_mask[ids]).sum()/outcome_mask[ids].sum().clamp_min(1)
            loss=selection_loss+.25*(predicate_loss*mask).sum()/mask.sum().clamp_min(1)+.2*torch.nn.functional.cross_entropy(r,recovery[ids])+.2*outcome_loss
            optimizer.zero_grad();loss.backward();optimizer.step();total+=loss.item()*len(ids)
        losses.append(total/len(records))
    training_seconds=time.perf_counter()-start;model.eval();torch.save(model.state_dict(),folder/'trained.pt');export('trained')
    reload=Controller();reload.load_state_dict(torch.load(folder/'trained.pt',weights_only=True));reload.eval()
    with torch.no_grad():expected=model(*sample)[0].numpy();reloaded=reload(*sample)[0].numpy();accuracy=float((model(*v[:3])[0].argmax(1)==v[3]).float().mean())
    session=ort.InferenceSession(str(folder/'trained.onnx'),providers=['CPUExecutionProvider']);feed={k:x.numpy() for k,x in zip(['image','history','candidates'],sample)}
    actual=session.run(None,feed)[0];times=[]
    for _ in range(100):
        t=time.perf_counter();session.run(None,feed);times.append((time.perf_counter()-t)*1000)
    report={'seed':seed,'parameters':sum(p.numel() for p in model.parameters()),'frozenParameters':0,'trainingSeconds':training_seconds,'losses':losses,'validationAccuracy':accuracy,'reloadMaxError':float(abs(expected-reloaded).max()),'onnxMaxError':float(abs(expected-actual).max()),'inferenceMsMedian':float(np.median(times)),'inferenceMsP95':float(np.quantile(times,.95)),'checkpointBytes':(folder/'trained.pt').stat().st_size,'onnxBytes':(folder/'trained.onnx').stat().st_size,'sha256':hashlib.sha256((folder/'trained.onnx').read_bytes()).hexdigest(),'updates':55*10,'dataSource':'controlled synthetic visual fixture, no pretrained encoder','trainSessionCount':600,'validationSessionCount':120}
    report['recordedRows']=recorded_count;report['trainSessionCount']=len(set(row['session'] for row in records));report['updates']=55*((len(records)+63)//64)
    report['contextVersion']=2 if recorded_count else 1
    if recorded_count:report['dataSource']='controlled synthetic images plus actual recorded pre-action fixture crops; candidate only'
    if os.name=='nt':
        import ctypes
        class MEM(ctypes.Structure):_fields_=[('cb',ctypes.c_ulong),('PageFaultCount',ctypes.c_ulong),('PeakWorkingSetSize',ctypes.c_size_t),('WorkingSetSize',ctypes.c_size_t),('QuotaPeakPagedPoolUsage',ctypes.c_size_t),('QuotaPagedPoolUsage',ctypes.c_size_t),('QuotaPeakNonPagedPoolUsage',ctypes.c_size_t),('QuotaNonPagedPoolUsage',ctypes.c_size_t),('PagefileUsage',ctypes.c_size_t),('PeakPagefileUsage',ctypes.c_size_t)]
        ctypes.windll.kernel32.GetCurrentProcess.restype=ctypes.c_void_p
        ctypes.windll.psapi.GetProcessMemoryInfo.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_ulong]
        mem=MEM();mem.cb=ctypes.sizeof(mem)
        if not ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(),ctypes.byref(mem),mem.cb):raise RuntimeError('Memory measurement failed')
        report['peakProcessRamBytes']=mem.PeakWorkingSetSize
    reports.append(report);(folder/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='losses'}),flush=True)
pathlib.Path('evidence').mkdir(exist_ok=True)
(root/'training.json' if pathlib.Path('evidence/audit-sealed.json').exists() else pathlib.Path('evidence/training.json')).write_text(json.dumps(reports,indent=2))
