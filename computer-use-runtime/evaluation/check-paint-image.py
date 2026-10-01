from PIL import Image
import numpy as np,json,pathlib,hashlib,sys
result=json.loads(pathlib.Path(sys.argv[1] if len(sys.argv)>1 else 'evidence/paint-png.json').read_text(encoding='utf-8'));p=pathlib.Path(result['path'])
check={'status':'FAIL','artifact':str(p),'evidenceLevel':'independent saved-image evaluator','requirements':['PNG signature','closed approximately 120-pixel square with four black edges']}
try:
    im=Image.open(p);check['format']=im.format;check['dimensions']=im.size
    a=np.asarray(im.convert('RGB'));black=(a.min(axis=2)<80)&(a.max(axis=2)<120);candidates=[]
    # Find horizontal runs. Pair equal spans with separated y coordinates and verify both vertical edges.
    rows=[]
    for y in range(min(im.height,800)):
        padded=np.pad(black[y].astype(np.int8),(1,1));starts=np.where(np.diff(padded)==1)[0];ends=np.where(np.diff(padded)==-1)[0]
        for x,end in zip(starts,ends):
            if 110<=end-x<=132:rows.append((int(x),int(end-1),y))
    for x1,x2,y1 in rows:
        for xx1,xx2,y2 in rows:
            if 110<=y2-y1<=132 and abs(x1-xx1)<=3 and abs(x2-xx2)<=3:
                left=black[y1:y2+1,max(0,x1-2):x1+3].any(axis=1).mean();right=black[y1:y2+1,x2-2:x2+3].any(axis=1).mean()
                if left>.95 and right>.95:candidates.append({'x':x1,'y':y1,'width':x2-x1,'height':y2-y1,'leftCoverage':float(left),'rightCoverage':float(right)})
    check['rectangles']=candidates[:10];check['sha256']=hashlib.sha256(p.read_bytes()).hexdigest();check['status']='PASS' if im.format=='PNG' and candidates else 'FAIL'
except Exception as e:check['reason']=str(e)
pathlib.Path(sys.argv[2] if len(sys.argv)>2 else 'evidence/paint-image-check.json').write_text(json.dumps(check,indent=2));print(json.dumps(check))
sys.exit(0 if check['status']=='PASS' else 1)
