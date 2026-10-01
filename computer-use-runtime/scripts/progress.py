"""Generate the completion checklist from saved, source-bound reports."""
import datetime
import importlib.util
import json
from pathlib import Path
from completion_gate import validate_completion

root = Path(__file__).resolve().parent.parent
previous_path = root / 'progress.json'
previous = json.loads(previous_path.read_text(encoding='utf-8')) if previous_path.exists() else {}
completion = previous.get('completion')
quality_path = root / 'evidence/review-quality.json'
quality = json.loads(quality_path.read_text(encoding='utf-8')) if quality_path.exists() else {}
spec = importlib.util.spec_from_file_location('source_identity', root / 'scripts/source-identity.py')
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)
current = identity.source_identity(root)
stamp = current['head'] + ':' + current['sha256']
index_path = root / 'docs/COMPLETION_EVIDENCE.json'
index = json.loads(index_path.read_text(encoding='utf-8')) if index_path.exists() else {}
commands = []
for entry in index.get('reports', []):
    if entry.get('kind') != 'execution':
        continue
    commands.append({
        'command': entry.get('command', 'See the saved report for its exact invocation'),
        'status': entry.get('status', 'NOT RUN'),
        'evidence': entry['path'],
        'source': entry.get('source'),
        'appliesToCurrentSource': entry.get('source') == stamp,
        'tasks': entry.get('tasks', []),
    })
issues = ['Frozen completion ledger is absent']
remaining = ['Restore the frozen completion ledger and run the required checks.']
if completion:
    manifest = json.loads((root / completion['requirements_snapshot']).read_text(encoding='utf-8'))
    issues = validate_completion(root, completion, current, manifest, index)
    remaining = [task['id'] + ': ' + task['next_action'] for task in completion['tasks']
                 if task.get('applicable', True) and task['status'] != 'PASS']
progress = {
    'schemaVersion': 1,
    'updatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'status': 'ACTIVE' if issues else 'COMPLETE',
    'fullRequestSatisfied': not issues,
    'source': stamp,
    'standaloneDirectory': 'computer-use-runtime',
    'hostApplicationsModified': False,
    'tests': {'status': quality.get('status', 'NOT RUN'), 'count': quality.get('tests'),
              'evidence': 'evidence/review-quality.json',
              'sourceBefore': quality.get('sourceBefore'), 'sourceAfter': quality.get('sourceAfter')},
    'commands': commands,
    'remaining': remaining,
    'completionIssues': issues,
    'gateDetails': 'CAPABILITIES.md',
    'verification': 'docs/VERIFICATION.md',
    'archive': 'release/computer-use-runtime-0.1.0.zip',
}
if completion:
    progress['completion'] = completion
previous_path.write_text(json.dumps(progress, indent=2) + '\n', encoding='utf-8')
lines = [
    '# Build state', '',
    'Status: ' + progress['status'] + '. scripts/completion_gate.py checks the frozen requirements, current execution evidence and separate reviews.', '',
    'Source: `' + stamp + '`.', '',
    'Regenerate this checklist with `python scripts/progress.py`. It reads saved reports and never changes sealed audit results or models.', '',
    '## Indexed execution evidence', '',
    '| Command | Saved result | Current source | Tasks | Evidence |',
    '|---|---|---|---|---|',
]
for item in commands:
    lines.append(f"| `{item['command']}` | {item['status']} | {'Yes' if item['appliesToCurrentSource'] else 'No'} | {', '.join(item['tasks'])} | `{item['evidence']}` |")
if not commands:
    lines += ['', 'No execution reports have completed task qualification in the hash-bound evidence index. Diagnostic attempts remain in evidence/ and the task attempt histories.']
lines += [
    '', '## Protected original audit', '',
    'The original 1,200 browser episodes remain sealed. Trained, fixed and no-compilation methods each scored 300/300. Initialized weights scored 25/300. Those results apply to the original protocol. They do not establish compiled-library efficiency, live macOS behavior or general native learning.', '',
    '## Quality report', '',
    f"The saved quality report is {quality.get('status', 'NOT RUN')} with {quality.get('tests', 'unknown')} tests. Its sourceBefore and sourceAfter fields identify the tested bytes. A later source change requires another run.", '',
    '## Remaining work', '',
]
lines += ['- ' + item for item in remaining] if remaining else ['No ledger task remains open. See completion validation below for any missing, stale or invalid evidence.']
lines += ['', '## Completion validation', '']
lines += ['- ' + item for item in issues] if issues else ['All frozen completion checks passed.']
lines += ['', 'Continue from [docs/HANDOFF.md](docs/HANDOFF.md). Evidence limits are in [docs/VERIFICATION.md](docs/VERIFICATION.md). Start with `npm start`, show the login token with `npm run token`, and stop with `npm stop` or Ctrl+C.']
(root / 'BUILD_STATE.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print(json.dumps({'status': progress['status'], 'reports': len(commands), 'tests': quality.get('tests'), 'issues': len(issues)}))
