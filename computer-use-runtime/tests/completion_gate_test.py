"""Regression checks for false-green completion, stale evidence and missing gates."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from completion_gate import validate_completion, TASK_FIELDS


class CompletionGateTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.current = {'head': 'reviewed-head', 'sha256': 'reviewed-code', 'files': []}
        self.stamp = 'reviewed-head:reviewed-code'
        task = {key: [] if key in ['dependencies', 'evidence_location', 'attempt_history', 'source_requirement', 'implementation_locations'] else 'fixture' for key in TASK_FIELDS}
        task.update(id='GATE-A', owner='engineer', reviewer='separate-reviewer', status='PASS', applicable=True, verified_source_revision=self.stamp, evidence_location=['run.json', 'review.json'])
        self.completion = {'tasks': [task]}
        frozen_fields = ['id', 'source_requirement', 'acceptance_criterion', 'dependencies', 'expected_result', 'applicable']
        snapshot = {'taskFields': frozen_fields, 'tasks': [{key: task[key] for key in frozen_fields}]}
        self.write('tasks.json', snapshot)
        self.manifest = {'taskSnapshot': {'path': 'tasks.json', 'sha256': self.sha('tasks.json'), 'count': 1}, 'sources': []}
        self.index = {'reports': []}
        for path, kind in [('run.json', 'execution'), ('review.json', 'review')]:
            report = {'status': 'PASS', 'sourceBefore': self.current, 'sourceAfter': self.current, 'sourceStable': True, 'checks': [{'exitCode': 0}]}
            if kind == 'review':
                report.update(reviewer='separate-reviewer', tasks=['GATE-A'])
            self.write(path, report)
            self.index['reports'].append({'path': path, 'sha256': self.sha(path), 'status': 'PASS', 'source': self.stamp, 'tasks': ['GATE-A'], 'kind': kind})

    def write(self, path, value):
        (self.root / path).write_text(json.dumps(value), encoding='utf-8')

    def sha(self, path):
        return hashlib.sha256((self.root / path).read_bytes()).hexdigest()

    def issues(self):
        return validate_completion(self.root, self.completion, self.current, self.manifest, self.index)

    def alter_report(self, path, updates):
        report = json.loads((self.root / path).read_text())
        report.update(updates)
        self.write(path, report)
        next(entry for entry in self.index['reports'] if entry['path'] == path)['sha256'] = self.sha(path)

    def test_current_execution_and_separate_review_pass(self):
        self.assertEqual(self.issues(), [])

    def test_missing_task_cannot_reduce_required_work(self):
        self.completion['tasks'].clear()
        self.assertIn('Frozen task IDs are missing or changed', self.issues())

    def test_applicability_and_criterion_cannot_be_weakened(self):
        self.completion['tasks'][0]['applicable'] = False
        self.assertTrue(any('frozen criterion' in issue for issue in self.issues()))

    def test_pass_label_does_not_cover_failed_or_absent_evidence(self):
        self.alter_report('run.json', {'status': 'FAIL'})
        self.assertTrue(any('did not pass' in issue for issue in self.issues()))
        (self.root / 'run.json').unlink()
        self.assertTrue(any('existing repository file' in issue for issue in self.issues()))

    def test_source_change_rejects_otherwise_green_execution(self):
        self.alter_report('run.json', {'sourceStable': False})
        self.assertTrue(any('source is stale' in issue for issue in self.issues()))

    def test_review_must_bind_task_and_separate_author(self):
        self.alter_report('review.json', {'reviewer': 'engineer'})
        self.assertTrue(any('separate reviewer' in issue for issue in self.issues()))

    def test_tampered_bytes_and_unindexed_reports_fail(self):
        self.write('run.json', {'status': 'PASS'})
        self.assertTrue(any('hash-bound' in issue for issue in self.issues()))
        self.index['reports'].clear()
        self.assertTrue(any('qualifying execution evidence absent' in issue for issue in self.issues()))

    def test_nonzero_command_and_failed_dependency_fail(self):
        self.alter_report('run.json', {'checks': [{'exitCode': 1}]})
        self.assertTrue(any('failed command' in issue for issue in self.issues()))
        extra = copy.deepcopy(self.completion['tasks'][0])
        extra.update(id='CONTRACT-01', status='FAIL')
        self.completion['tasks'].append(extra)
        self.completion['tasks'][0]['dependencies'] = ['CONTRACT-01']
        self.assertTrue(any('dependency has not passed' in issue for issue in self.issues()))


if __name__ == '__main__':
    unittest.main()
