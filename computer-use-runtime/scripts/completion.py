"""Render the one execution queue and reject missing, failed or stale acceptance."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import datetime
import shutil
import uuid
from completion_gate import validate_completion

root = Path(__file__).resolve().parent.parent
identity_spec = importlib.util.spec_from_file_location('source_identity', root / 'scripts/source-identity.py')
identity_module = importlib.util.module_from_spec(identity_spec)
identity_spec.loader.exec_module(identity_module)
current = identity_module.source_identity(root)
progress = json.loads((root / 'progress.json').read_text(encoding='utf-8'))
completion = progress['completion']
tasks = completion['tasks']
manifest = json.loads((root / completion['requirements_snapshot']).read_text(encoding='utf-8'))
index = json.loads((root / 'docs/COMPLETION_EVIDENCE.json').read_text(encoding='utf-8'))
issues = validate_completion(root, completion, current, manifest, index)
lines = ['# Completion checklist', '', 'Generated from `progress.json` by `python scripts/completion.py`. PASS requires current implementation evidence and a separate reviewer. The frozen contract is `completion-contract-v1/manifest.json`.', '', '| Task | State | Requirement and acceptance | Owner | Next action |', '|---|---|---|---|---|']
for task in tasks:
    lines.append('| ' + ' | '.join([task['id'], task['status'], task['acceptance_criterion'].replace('|', '\\|'), task['owner'], task['next_action'].replace('|', '\\|')]) + ' |')
(root / 'docs/COMPLETION_CHECKLIST.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
after = identity_module.source_identity(root)
if after != current:
    issues.append('Maintained source changed during completion validation')
report = {'status': 'PASS' if not issues else 'FAIL', 'source': current['head'] + ':' + current['sha256'], 'sourceBefore': current, 'sourceAfter': after, 'sourceStable': current == after, 'requiredTasks': sum(task.get('applicable', True) for task in tasks), 'issues': issues}
(root / 'evidence/completion').mkdir(exist_ok=True)
attempt = root / 'evidence/completion/aggregate' / (datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + str(uuid.uuid4()))
attempt.mkdir(parents=True)
prior = root / 'evidence/completion/aggregate.json'
if prior.is_file():
    shutil.copy2(prior, attempt / 'prior-latest-report.json')
(attempt / 'results.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
(root / 'evidence/completion/aggregate.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
print(json.dumps({key: report[key] for key in ['status', 'source', 'requiredTasks', 'issues']} | {'evidence': str(attempt.relative_to(root) / 'results.json')}, indent=2))
if '--render' not in sys.argv:
    raise SystemExit(0 if not issues else 1)
