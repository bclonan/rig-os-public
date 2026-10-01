import json,pathlib,sqlite3,hashlib,shutil
root=pathlib.Path('evidence/portable-audit');root.mkdir(exist_ok=True);artifacts=root/'artifacts';artifacts.mkdir(exist_ok=True)
result=json.loads(pathlib.Path('evidence/results.json').read_text());source=pathlib.Path(result['auditStore']);db=sqlite3.connect('file:'+str(source/'runtime.sqlite')+'?mode=ro',uri=True)
references=set();count=0
with (root/'events.jsonl').open('w',encoding='utf-8') as out:
    for seq,run_id,correlation,at,kind,data in db.execute('SELECT seq,run_id,correlation,at,type,data FROM events ORDER BY seq'):
        body=json.loads(data);out.write(json.dumps({'schemaVersion':1,'seq':seq,'runId':run_id,'correlationId':correlation,'at':at,'type':kind,'data':body},separators=(',',':'))+'\n');count+=1
        def visit(v):
            if isinstance(v,dict):
                if isinstance(v.get('image'),str) and len(v['image'])==64:references.add(v['image'])
                for x in v.values():visit(x)
            elif isinstance(v,list):
                for x in v:visit(x)
        visit(body)
runs=[json.loads(r[0]) for r in db.execute('SELECT body FROM runs')];(root/'runs.json').write_text(json.dumps(runs,separators=(',',':')),encoding='utf-8')
for key in references:
    if len(key)!=64 or any(c not in '0123456789abcdef' for c in key):raise ValueError('Invalid image reference')
    data=(source/'artifacts'/key).read_bytes()
    if hashlib.sha256(data).hexdigest()!=key:raise ValueError('Artifact corruption')
    (artifacts/key).write_bytes(data)
files=[{'path':str(p.relative_to(root)).replace('\\','/'),'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in root.rglob('*') if p.is_file() and p.name!='manifest.json']
(root/'manifest.json').write_text(json.dumps({'schemaVersion':1,'kind':'portable-audit-evidence','source':'isolated controlled browser fixture only','events':count,'runs':len(runs),'images':len(references),'files':files},indent=2));print(json.dumps({'events':count,'runs':len(runs),'images':len(references)}))
