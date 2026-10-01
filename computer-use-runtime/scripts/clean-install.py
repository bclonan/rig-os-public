"""Stage only the standalone package, install twice, and exercise the built service."""
import pathlib,shutil,subprocess,json,time,os,importlib.util,datetime,uuid
from process_supervisor import run_command
from package_evidence import TRAINING_ORIGIN_FILES
root=pathlib.Path.cwd();stage=root/'release'/('clean-install-'+str(int(time.time())));stage.mkdir(parents=True)
identity_spec=importlib.util.spec_from_file_location('source_identity',root/'scripts/source-identity.py')
identity=importlib.util.module_from_spec(identity_spec);identity_spec.loader.exec_module(identity)
source_before=identity.source_identity(root)
attempt=root/'evidence/completion/clean-install'/(datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+str(uuid.uuid4()));attempt.mkdir(parents=True)
prior=root/'evidence/review-clean-install.json'
if prior.is_file():shutil.copy2(prior,attempt/'prior-latest-report.json')
for name in ['src','console','fixtures','tests','evaluation','scripts','sdk','examples','learner','schemas','skills','docs']:
    shutil.copytree(root/name,stage/name,ignore=shutil.ignore_patterns('__pycache__'))
for name in ['package.json','package-lock.json','tsconfig.json','tsconfig.console.json','vite.config.ts','acceptance.json','REQUEST.md','.prettierrc.json','.prettierignore','.gitattributes','AGENTS.md']:
    shutil.copy2(root/name,stage/name)
shutil.copytree(root/'native',stage/'native',ignore=shutil.ignore_patterns('target','__pycache__'))
(stage/'models').mkdir();(stage/'evidence').mkdir()
for seed in ['17','41','73']:shutil.copytree(root/'models'/seed,stage/'models'/seed)
for name in ['results.json','episodes.jsonl','audit-sealed.json','training.json','protocol.sha256']:
    shutil.copy2(root/'evidence'/name,stage/'evidence'/name)
# The historical terminal compatibility regression checks these exact reviewed
# bytes. Copy its inputs without admitting a private evaluator key or Store.
for name in ['learning-followup-v4/protocol.json','learning-followup-v4/browser/results.json','learning-followup-v4/browser/audit-sealed.json']:
    destination=stage/'evidence'/name;destination.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(root/'evidence'/name,destination)
# Provenance tests read exact public selected inputs and historical source bytes.
# Copy only named members. This admits neither evaluator authority nor Stores.
selected = ['selection.json', 'training.json', 'train-manifest.json',
            'validation-manifest.json', 'operational.json',
            'conditional-parity.json', 'program-bank.json']
selected += [f'models/{seed}/{name}' for seed in (17, 41, 73)
             for name in ('initialized.onnx', 'trained.onnx', 'initialized.pt',
                          'trained.pt', 'report.json')]
for name in selected:
    relative = pathlib.Path('evidence/learning-followup-v4/browser') / name
    destination = stage / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / relative, destination)
for name in sorted(TRAINING_ORIGIN_FILES):
    destination = stage / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / name, destination)
npm='npm.cmd' if os.name=='nt' else 'npm'
npx='npx.cmd' if os.name=='nt' else 'npx'
setup=['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/setup.ps1'] if os.name=='nt' else ['sh','scripts/setup.sh']
planned=[setup,setup,[npm,'run','lint'],[npm,'test'],[npm,'run','verify:audit'],[npx,'tsx','evaluation/offline.ts'],[npx,'tsx','evaluation/service-usability.ts']]
commands=[]
def save(status):
    source_after=identity.source_identity(root)
    stable=source_before==source_after
    if status=='PASS' and not stable:status='FAIL'
    report={'status':status,'level':'fresh source directory on '+os.name+' host; installed Python dependencies and browser cache reused','isolatedNodeModules':True,'usesInstalledNodeAndBrowserCache':True,'stage':str(stage),'plannedCommands':len(planned),'commands':commands,'checks':commands,'sourceBefore':source_before,'sourceAfter':source_after,'sourceStable':stable}
    text=json.dumps(report,indent=2)
    (root/'evidence'/'review-clean-install.json').write_text(text)
    (attempt/'results.json').write_text(text)
    return status
save('RUNNING')
for args in planned:
    start=time.perf_counter()
    result=run_command(args,cwd=stage,timeout=240)
    code,output=result.exit_code,result.output.decode('utf-8',errors='replace')
    log=attempt/('command-'+str(len(commands))+'.log');log.write_bytes(result.output)
    commands.append({'command':args,'exitCode':code,'elapsedSeconds':time.perf_counter()-start,'log':log.relative_to(root).as_posix(),'tail':output[-2000:],'ownedPid':result.pid,'commandPid':result.command_pid,'ownership':result.ownership,'timedOut':result.timed_out,'interrupted':result.interrupted,'error':result.error,'cleanupErrors':result.cleanup_errors})
    save('FAIL' if code else 'RUNNING')
    if code:raise RuntimeError('Clean installation command failed: '+str(args)+'\n'+output[-2000:])
if save('PASS')!='PASS':raise RuntimeError('Maintained source changed during isolated reproduction')
print(json.dumps({'stage':str(stage),'status':'PASS','commands':len(commands)}))
