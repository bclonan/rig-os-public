import json,pathlib,hashlib,urllib.request,importlib.metadata
root=pathlib.Path('.');out=root/'licenses';out.mkdir(exist_ok=True);records=json.loads((root/'evidence/upstream/index.json').read_text())
lines=['# Third-party components','', 'Source inspection took place on 2026-09-29. Commit identifiers below are the inspected snapshots. npm package versions come from package-lock.json, not repository HEAD. No code from game-client injection or anti-cheat projects was imported.','', '## Runtime dependencies','', 'The implementation directly uses XState, Playwright, Vue, Fastify, TypeBox, Ajv, ONNX Runtime, the official MCP SDK, PyTorch, NumPy, Pillow, ONNX, and the Rust Windows bindings. Exact package versions and declared licenses are in evidence/dependency-manifest.json and the lockfiles. Installed third-party runtimes are not included in the source archive. Retain their license and notice files when redistributing those runtimes.','', 'Oculix is used through the pinned MCP interface. Source MCP reports version 4.0.0 and requires Java 17 or later; its README described an older version and Java requirement. The tested isolated JDK is Temurin 21.0.12.1+1. The built MCP jar is about 214 MB. The archive supplies the bootstrap script, exact commit and license instead of redistributing the jar and its transitive binary payload. Oculix tools were discovered live and checked against their JSON schemas. Rust supplements missing drag, hold and UIA operations.','', '## Inspected research candidates','', '| Repository | Commit | Repository license | Reuse |','|---|---|---|---|']
for r in records:
    repo=r['repository'];license=(r.get('license') or {}).get('spdx_id','Unverified');reuse='README/license reviewed; no code or weights imported'
    if repo=='oculix-org/Oculix':reuse='Actual MCP tools and pinned source build'
    elif repo=='statelyai/xstate':reuse='Maintained statechart executor, npm 5.33.2'
    elif repo=='microsoft/playwright':reuse='Browser adapter, npm 1.63.0'
    elif repo in ['xlang-ai/OSWorld','microsoft/WindowsAgentArena']:reuse='Custom-agent interface inspected; narrow mapping and contract test, no VM score'
    lines.append(f"| [{repo}]({r.get('url','https://github.com/'+repo)}) | `{r.get('commit','unavailable')}` | {license} | {reuse} |")
lines+=['', 'Model, dataset and source licenses are separate. OmniParser weights/data were not downloaded and their separate terms were not admitted as dependencies. Repository license metadata alone does not establish a model/data license. GPL research candidates and MPL OpenRPA remain references only.','', '## Models and data','', 'The owned controller code and controlled fixture generator were written in this package. No pretrained encoder or external training dataset is included. qwen3:1.7b and qwen3.5:0.8b are optional local providers. Their installed metadata, digests and license text are recorded separately. qwen3.6:latest was already installed and was used for a creative plan that failed semantic acceptance. No local provider weights are in the archive.','', 'The image-input adapter follows [Ollama\'s documented vision API](https://docs.ollama.com/capabilities/vision). It checks advertised vision support before sending a canvas crop. No private or undocumented subscription API is used.']
(root/'THIRD_PARTY.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
for p in (root/'evidence/upstream').glob('*LICENSE*'):(out/p.name).write_bytes(p.read_bytes())
for p in (root/'evidence/upstream').glob('*license.txt'):(out/p.name).write_bytes(p.read_bytes())
lock=json.loads((root/'package-lock.json').read_text());dependencies=[]
for path,item in lock['packages'].items():
    if path:dependencies.append({'package':path,'version':item.get('version'),'license':item.get('license'),'integrity':item.get('integrity'),'dev':item.get('dev',False)})
python=[]
for name in ['torch','numpy','Pillow','onnx','onnxscript','onnxruntime']:
    md=importlib.metadata.metadata(name);python.append({'name':name,'version':importlib.metadata.version(name),'license':md.get('License-Expression') or md.get('License')})
(root/'evidence/dependency-manifest.json').write_text(json.dumps({'npm':dependencies,'python':python},indent=2))
tags=json.load(urllib.request.urlopen('http://127.0.0.1:11434/api/tags'));providers=[]
for model in tags['models']:
    if model['name'] not in ['qwen3:1.7b','qwen3.5:0.8b','qwen3.6:latest']:continue
    req=urllib.request.Request('http://127.0.0.1:11434/api/show',data=json.dumps({'model':model['name']}).encode(),headers={'Content-Type':'application/json'});metadata=json.load(urllib.request.urlopen(req));license=metadata.get('license','');filename='model-'+model['name'].replace(':','-')+'.txt';(out/filename).write_text(license,encoding='utf-8');providers.append({'name':model['name'],'digest':model['digest'],'bytes':model['size'],'capabilities':metadata.get('capabilities'),'details':metadata.get('details'),'licenseFile':'licenses/'+filename,'licenseSha256':hashlib.sha256(license.encode()).hexdigest()})
(root/'evidence/provider-manifest.json').write_text(json.dumps(providers,indent=2))
