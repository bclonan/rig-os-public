"""Require the frozen queue, current execution reports and independent reviews."""
import hashlib
import json

TASK_FIELDS = ['id', 'source_requirement', 'acceptance_criterion', 'dependencies', 'owner', 'status', 'implementation_locations', 'verification_command_or_procedure', 'expected_result', 'actual_result', 'evidence_location', 'verified_source_revision', 'reviewer', 'attempt_history', 'next_action']


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def local_file(root, name):
    if not isinstance(name, str) or not name:
        raise ValueError('Absent evidence path')
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError('Evidence must be an existing repository file: ' + name)
    return path


def report_source(report):
    if report.get('sourceStable') is not True:
        return ''
    before, after = report.get('sourceBefore', {}), report.get('sourceAfter', {})
    if before != after or not after.get('head') or not after.get('sha256'):
        return ''
    return after['head'] + ':' + after['sha256']


def validate_completion(root, completion, current, manifest, index):
    issues = []
    tasks = completion['tasks']
    stamp = current['head'] + ':' + current['sha256']
    by_id = {task['id']: task for task in tasks}
    if len(by_id) != len(tasks):
        issues.append('Duplicate task IDs')
    try:
        entry = manifest['taskSnapshot']
        path = local_file(root, entry['path'])
        if digest(path) != entry['sha256']:
            raise ValueError('Frozen task map hash changed')
        snapshot = json.loads(path.read_text(encoding='utf-8'))
        frozen = {task['id']: task for task in snapshot['tasks']}
        if set(by_id) != set(frozen) or len(tasks) != entry['count']:
            issues.append('Frozen task IDs are missing or changed')
        for task in tasks:
            if task['id'] in frozen and any(task.get(field) != frozen[task['id']].get(field) for field in snapshot['taskFields']):
                issues.append(task['id'] + ': frozen criterion, applicability or dependency changed')
    except (KeyError, ValueError, OSError, json.JSONDecodeError) as error:
        issues.append('Frozen task map unavailable: ' + str(error))
    for entry in manifest.get('sources', []):
        try:
            if digest(local_file(root, entry['snapshot'])) != entry['sha256']:
                raise ValueError('snapshot bytes changed')
            if entry['source'] in ['REQUEST.md', 'acceptance.json'] and digest(local_file(root, entry['source'])) != entry['sha256']:
                raise ValueError('original bytes changed')
        except (ValueError, OSError) as error:
            issues.append('Frozen requirement changed: ' + entry['source'] + ': ' + str(error))
    reports = {entry['path']: entry for entry in index.get('reports', [])}
    for task in tasks:
        name = task['id']
        for field in TASK_FIELDS:
            if field not in task:
                issues.append(name + ': missing ' + field)
        for dependency in task.get('dependencies', []):
            if dependency not in by_id:
                issues.append(name + ': missing dependency ' + dependency)
            elif task.get('status') == 'PASS' and by_id[dependency].get('applicable', True) and by_id[dependency].get('status') != 'PASS':
                issues.append(name + ': dependency has not passed ' + dependency)
        if not task.get('applicable', True):
            continue
        if task.get('status') != 'PASS':
            issues.append(name + ': ' + str(task.get('status')))
            continue
        if task.get('verified_source_revision') != stamp:
            issues.append(name + ': stale source identity')
        if not task.get('reviewer') or task['reviewer'] == task.get('owner'):
            issues.append(name + ': independent review absent')
        result_count = review_count = 0
        for location in task.get('evidence_location', []):
            try:
                path = local_file(root, location)
                entry = reports.get(location)
                if not entry or digest(path) != entry.get('sha256') or name not in entry.get('tasks', []):
                    raise ValueError('evidence is absent from the hash-bound task index')
                report = json.loads(path.read_text(encoding='utf-8'))
                if report.get('status') != 'PASS' or entry.get('status') != 'PASS':
                    raise ValueError('evidence did not pass')
                if report_source(report) != stamp or entry.get('source') != stamp:
                    raise ValueError('evidence source is stale, missing or changed during execution')
                if any(check.get('exitCode', 0) != 0 for check in report.get('checks', []) if isinstance(check, dict)):
                    raise ValueError('evidence contains a failed command')
                if entry.get('kind') == 'review':
                    if report.get('reviewer') != task.get('reviewer') or report.get('reviewer') == task.get('owner') or name not in report.get('tasks', []):
                        raise ValueError('review does not bind this task and separate reviewer')
                    review_count += 1
                elif entry.get('kind') == 'execution':
                    result_count += 1
                else:
                    raise ValueError('unknown evidence kind')
            except (ValueError, KeyError, OSError, json.JSONDecodeError) as error:
                issues.append(name + ': ' + location + ': ' + str(error))
        if not result_count:
            issues.append(name + ': qualifying execution evidence absent')
        if not review_count:
            issues.append(name + ': qualifying independent review evidence absent')
    return issues
