"""Run local quality gates and retain commands, outcomes and source identity."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import shutil
import uuid
from process_supervisor import run_command
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
sys.stderr.reconfigure(encoding='utf-8', errors='replace')

root = Path(__file__).resolve().parent.parent
identity_spec = importlib.util.spec_from_file_location('source_identity', root / 'scripts/source-identity.py')
identity_module = importlib.util.module_from_spec(identity_spec)
identity_spec.loader.exec_module(identity_module)
source_before = identity_module.source_identity(root)
attempt = root / 'evidence/completion/quality' / (datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + str(uuid.uuid4()))
attempt.mkdir(parents=True)
prior = root / 'evidence/review-quality.json'
if prior.is_file():
    shutil.copy2(prior, attempt / 'prior-latest-report.json')
npm = 'npm.cmd' if os.name == 'nt' else 'npm'
commands = [
    [npm, 'run', 'check'],
    [npm, 'run', 'verify:audit'],
    [npm, 'audit', '--audit-level=high'],
    ['cargo', 'fmt', '--manifest-path', 'native/Cargo.toml', '--', '--check'],
    ['cargo', 'clippy', '--manifest-path', 'native/Cargo.toml', '--all-targets', '--', '-D', 'warnings'],
    ['git', 'diff', '--check', '--', '.'],
    [sys.executable, '-c', "import pathlib,py_compile; files=[p for d in ['learner','native/unix','src/providers','sdk','examples','scripts','evaluation','tests'] for p in pathlib.Path(d).rglob('*.py') if '__pycache__' not in p.parts]; [py_compile.compile(str(p),doraise=True) for p in files]; print(str(len(files))+' Python files compiled')"],
    [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', '*_test.py'],
]
report = {'status': 'RUNNING', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'platform': os.name, 'checks': []}
def persist():
    (attempt / 'results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
report['sourceBefore'] = source_before
persist()
for index, command in enumerate(commands):
    start = time.perf_counter()
    result = run_command(command, cwd=root, timeout=180)
    output = result.output.decode('utf-8', errors='replace')
    code = result.exit_code
    log = (attempt / f'command-{index}.log').relative_to(root).as_posix()
    (root / log).write_bytes(result.output)
    if index == 0:
        count = re.search(r'tests (\d+)', output)
        if count:
            report['tests'] = int(count.group(1))
    report['checks'].append({'command': command, 'exitCode': code, 'seconds': round(time.perf_counter() - start, 3), 'log': log, 'ownedPid': result.pid, 'commandPid': result.command_pid, 'ownership': result.ownership, 'timedOut': result.timed_out, 'interrupted': result.interrupted, 'error': result.error, 'cleanupErrors': result.cleanup_errors})
    report['status'] = 'FAIL' if any(check['exitCode'] for check in report['checks']) else 'RUNNING'
    persist()
    print(json.dumps(report['checks'][-1]), flush=True)
    if code:
        print(output[-3500:], flush=True)
    if result.interrupted:
        break
source_after = identity_module.source_identity(root)
report['sourceBefore'] = source_before
report['sourceAfter'] = source_after
report['sourceSha256'] = source_after['sha256']
report['sourceStable'] = source_before == source_after
report['status'] = 'PASS' if report['sourceStable'] and len(report['checks']) == len(commands) and all(c['exitCode'] == 0 for c in report['checks']) else 'FAIL'
if not report['sourceStable']:
    print('FAIL: maintained source changed during verification; no fresh acceptance stamp issued.', flush=True)
(root / 'evidence/review-quality.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
persist()
raise SystemExit(0 if report['status'] == 'PASS' else 1)
