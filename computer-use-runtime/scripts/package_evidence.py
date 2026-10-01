"""Select owned fixture evidence and summarize private local qualifications."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re

CONTROLLED_TREES = (
    'evidence/portable-audit',
    'evidence/linux-portal-v1',
    'evidence/learning-followup-v1/browser',
    'evidence/learning-followup-v2/browser',
    'evidence/learning-followup-v3/browser',
    'evidence/learning-followup-v4/browser',
    'evidence/learning-followup-library-v1',
)
TRAINING_ORIGIN_FILES = frozenset(
    'evidence/learning-followup-v4-training-origin-v1/' + name for name in (
        'manifest.json', 'results.json', 'audit-sealed.json', 'selection.json',
        'sources/learner/model.py', 'sources/learner/model_v4.py',
        'sources/learner/followup_v4_train.py', 'sources/learner/recorded.py',
        'sources/src/learner/descriptor.ts',
        'sources/evaluation/learning-followup-v4.protocol.json',
    )
)
CONTROLLED_FILES = TRAINING_ORIGIN_FILES | frozenset('evidence/' + name for name in (
    'results.json', 'episodes.jsonl', 'audit-sealed.json', 'training.json',
    'protocol.sha256', 'dataset-bundle.json', 'corrected-dataset-bundle.json',
    'review-console.json', 'review-console-final.json',
    'review-console.png', 'review-console-mobile.png',
    'learning-followup-v1/protocol.json', 'learning-followup-v2/protocol.json',
    'learning-followup-v3/protocol.json', 'learning-followup-v4/protocol.json',
))


def evidence_allowed(name):
    path = PurePosixPath(name.replace('\\', '/'))
    if path.is_absolute() or '..' in path.parts:
        return False
    normalized = path.as_posix()
    if not normalized.startswith('evidence/'):
        return True
    return normalized in CONTROLLED_FILES or any(
        normalized.startswith(folder + '/') for folder in CONTROLLED_TREES
    )


def qualification_summary(root):
    root = Path(root)
    reports = []
    statuses = {'PASS', 'FAIL', 'RUNNING', 'BLOCKED', 'BLOCKED_EXTERNAL', 'NOT RUN', 'UNVERIFIED'}
    for path in sorted((root / 'evidence/completion').rglob('*.json')):
        if any(part in {'target', '.data', 'store', 'artifacts', 'node_modules'} for part in path.parts):
            continue
        data = path.read_bytes()
        try:
            raw = json.loads(data)
        except (ValueError, UnicodeError):
            continue
        if not isinstance(raw, dict) or raw.get('status') not in statuses:
            continue
        name = path.relative_to(root).as_posix()
        # Only generated local evidence names belong in the exported reference.
        if not re.fullmatch(r'[A-Za-z0-9_./-]+', name):
            continue
        entry = {'localRawPath': name, 'localRawSha256': hashlib.sha256(data).hexdigest(),
                 'reportedStatus': raw['status']}
        for key in ('sourceStable', 'binariesStable', 'sourceUnchanged', 'binariesUnchanged'):
            if type(raw.get(key)) is bool:
                entry[key] = raw[key]
        for key in ('sourceBefore', 'sourceAfter'):
            identity = raw.get(key)
            if isinstance(identity, dict) and re.fullmatch(r'[0-9a-f]{40}', str(identity.get('head', ''))) and re.fullmatch(r'[0-9a-f]{64}', str(identity.get('sha256', ''))):
                entry[key] = {field: identity[field] for field in ('head', 'sha256')}
        checks = raw.get('checks')
        if isinstance(checks, list):
            entry['commandExitCodes'] = [c['exitCode'] for c in checks if isinstance(c, dict) and type(c.get('exitCode')) is int]
        reports.append(entry)
    return {'schemaVersion': 1, 'status': 'METADATA_SUMMARY',
            'scope': 'Local qualification statuses and byte references only. Raw captures, inspection records and errors remain in the original workspace. This file does not certify acceptance.',
            'reports': reports}
