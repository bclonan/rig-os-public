"""Create a source, native binary, model and controlled-evidence archive from an allowlist."""
import pathlib,json,zipfile,hashlib,os,re,importlib.util,datetime,uuid
from package_evidence import CONTROLLED_FILES, CONTROLLED_TREES, TRAINING_ORIGIN_FILES, evidence_allowed, qualification_summary
root=pathlib.Path.cwd();release=root/'release';release.mkdir(exist_ok=True);files={}
def add(path):
    if not evidence_allowed(path):return
    p=root/path
    if p.is_file():files[path.replace('\\','/')]=p.read_bytes()
def tree(folder):
    for p in (root/folder).rglob('*'):
        if p.is_file() and not any(part in ['__pycache__','target','train-store','validation-store','audit-store','.data'] for part in p.parts) and p.name != '.evaluator.key' and not any(p.name.endswith(suffix) for suffix in ['.pyc','.token','.sqlite','.sqlite-wal','.sqlite-shm','.sqlite3','.sqlite3-wal','.sqlite3-shm']):
            add(str(p.relative_to(root)))
for folder in ['docs','src','console','fixtures','learner','sdk','examples','tests','evaluation','scripts','schemas','skills','licenses','datasets','dist']:tree(folder)
for name in ['AGENTS.md','.prettierrc.json','.prettierignore','.gitattributes','tsconfig.console.json','README.md','ARCHITECTURE.md','SECURITY.md','CAPABILITIES.md','THIRD_PARTY.md','BUILD_STATE.md','progress.json','REQUEST.md','acceptance.json','package.json','package-lock.json','tsconfig.json','vite.config.ts','.gitignore']:add(name)
for seed in ['17','41','73']:tree('models/'+seed)
tree('models/recorded-candidate')
for name in ['native/Cargo.toml','native/Cargo.lock','native/target/release/computer-use-native.exe','native/target/release/disposable-editor.exe']:add(name)
tree('native/src');tree('native/unix')
for folder in CONTROLLED_TREES:
    tree(folder)
for name in sorted(CONTROLLED_FILES):add(name)
add('PLATFORMS.md')
# Raw desktop inspections stay local. Export status and byte references only.
files['evidence/qualification-summary.json']=(json.dumps(qualification_summary(root),indent=2)+'\n').encode()
# Redact machine-local directory paths in unsealed metadata. Sealed audit objects keep their original bytes.
sealed={'evidence/results.json','evidence/episodes.jsonl','evidence/audit-sealed.json','evidence/training.json'}
# Preserve the exact protocol bytes used to select and qualify each followup.
sealed.update('evidence/learning-followup-'+version+'/protocol.json' for version in ['v1','v2','v3','v4'])
# Public origin metadata belongs to exact reviewed digests. Never scrub its bytes.
sealed.update(TRAINING_ORIGIN_FILES)
for path,data in list(files.items()):
    bound_prefixes=tuple(folder+'/' for folder in CONTROLLED_TREES)
    if path.startswith('evidence/') and path.endswith('.json') and path not in sealed and not path.startswith(bound_prefixes):
        try:
            value=json.loads(data)
            def scrub(v):
                if isinstance(v,str):return v.replace(str(root),'${WORKSPACE}').replace(str(root).replace('\\','/'),'${WORKSPACE}')
                if isinstance(v,dict):return {k:scrub(x) for k,x in v.items()}
                if isinstance(v,list):return [scrub(x) for x in v]
                return v
            files[path]=(json.dumps(scrub(value),indent=2)+'\n').encode()
        except (ValueError,UnicodeError):raise RuntimeError('Invalid JSON in release allowlist: '+path)
secrets=[p.read_bytes().strip() for p in [root/'.data/service.token',root/'.data/service/service.token'] if p.exists()]
for path,data in files.items():
    if any(part in ['node_modules','.data','.tools','.research','.venv','.venv-desktop','.candidates','train-store','validation-store','audit-store'] for part in pathlib.PurePosixPath(path).parts) or pathlib.PurePosixPath(path).name=='.evaluator.key':raise RuntimeError('Excluded directory admitted: '+path)
    if any(secret and secret in data for secret in secrets):raise RuntimeError('Service token found in release file: '+path)
identity_spec=importlib.util.spec_from_file_location('release_source_identity',root/'scripts/source-identity.py')
identity_module=importlib.util.module_from_spec(identity_spec);identity_spec.loader.exec_module(identity_module)
source_identity=identity_module.source_identity(root)
manifest={'schemaVersion':1,'name':'computer-use-runtime','version':'0.1.0','sourceIdentity':{key:source_identity[key] for key in ['head','headOrigin','sha256']},'includes':'source, Windows x64 native binaries, compiled console, owned models, controlled browser and portal evidence, local qualification metadata references','excludes':['tokens','runtime databases','installed dependency folders','downloaded provider weights','Oculix binary payload','raw native captures','desktop window inventories','file-dialog inspections','diagnostic artifact stores','unrelated application screenshots'],'files':[{'path':path,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()} for path,data in sorted(files.items())]}
manifest_bytes=(json.dumps(manifest,indent=2)+'\n').encode();files['RELEASE_MANIFEST.json']=manifest_bytes
suffix=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+source_identity['sha256'][:12]+'-'+uuid.uuid4().hex[:8]
archive=release/('computer-use-runtime-0.1.0-'+suffix+'.zip')
with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for path,data in sorted(files.items()):z.writestr('computer-use-runtime/'+path,data)
with zipfile.ZipFile(archive) as z:
    if z.testzip():raise RuntimeError('Archive CRC check failed')
    for f in manifest['files']:
        if hashlib.sha256(z.read('computer-use-runtime/'+f['path'])).hexdigest()!=f['sha256']:raise RuntimeError('Archive content hash mismatch')
digest=hashlib.sha256(archive.read_bytes()).hexdigest();archive.with_suffix('.zip.sha256').write_text(digest+'  '+archive.name+'\n');archive.with_suffix('.manifest.json').write_bytes(manifest_bytes)
report={'status':'PASS','archive':str(archive),'sha256':digest,'bytes':archive.stat().st_size,'files':len(files),'sourceIdentity':manifest['sourceIdentity'],'tokenScan':'PASS','crcAndContentHashes':'PASS'};archive.with_suffix('.package-check.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
