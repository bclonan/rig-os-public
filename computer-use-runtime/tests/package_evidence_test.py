"""Exercise the actual archive builder with private-inspection sentinels."""
import importlib.util
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_evidence', ROOT / 'scripts/package_evidence.py')
selection = importlib.util.module_from_spec(spec)
spec.loader.exec_module(selection)


class PackageEvidenceTests(unittest.TestCase):
    def test_actual_archive_excludes_private_inspections_and_preserves_owned_bytes(self):
        parent = ROOT / 'evidence/completion/repair-tests/package-privacy'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='archive-fixture-', dir=parent) as temporary:
            fixture = Path(temporary).resolve()
            self.assertTrue(fixture.is_relative_to(parent.resolve()))
            files = {
                'evidence/completion/review/native/stages.jsonl': b'PRIVATE_WINDOW_SENTINEL',
                'evidence/completion/review/native/dialog.bmp': b'PRIVATE_IMAGE_SENTINEL',
                'evidence/completion/native-tasks/store/artifacts/opaque': b'PRIVATE_BLOB_SENTINEL',
                'evidence/completion/native-tasks/results.json': b'{"status":"PASS","windows":["PRIVATE_COMPLETION_SENTINEL"]}',
                'evidence/review-native/results.json': b'{"status":"PASS","windows":["PRIVATE_LEGACY_SENTINEL"]}',
                'evidence/editor-save.json': b'{"status":"PASS","events":["PRIVATE_EDITOR_SENTINEL"]}',
                'evidence/learning-followup-v1/native/capture.png': b'PRIVATE_NATIVE_SENTINEL',
                'evidence/learning-followup-v4/browser/17/trained.onnx': b'owned-model-bytes',
                'evidence/learning-followup-v4/browser/images/owned.png': b'owned-browser-bytes',
                'evidence/results.json': b'{"sealed":"owned-browser"}',
                'native/target/release/computer-use-native.exe': b'packaging-fixture-native',
                'native/target/release/disposable-editor.exe': b'packaging-fixture-editor',
                'scripts/setup.sh': (ROOT / 'scripts/setup.sh').read_bytes(),
            }
            # These are archive-format fixtures, not a qualified origin or model.
            # Their exact bytes deliberately contain this local root to detect
            # accidental rewriting of attested public provenance metadata.
            for name in selection.TRAINING_ORIGIN_FILES:
                files[name] = (json.dumps({'unqualifiedArchiveFixture': str(fixture)})
                               + '\r\n').encode()
            files['evidence/learning-followup-v4-training-origin-v1/private-inspection.json'] = b'PRIVATE_ORIGIN_SENTINEL'
            files['evidence/learning-followup-v4-training-origin-v1/.evaluator.key'] = b'PRIVATE_KEY_SENTINEL'
            # Frozen protocols belong to the selected evidence. JSON equality
            # cannot replace the byte identity bound by its protected audit.
            protocols = tuple('evidence/learning-followup-' + version + '/protocol.json'
                              for version in ('v1', 'v2', 'v3', 'v4'))
            for index, name in enumerate(protocols):
                files[name] = ('{ "id": "frozen-' + str(index) + '", "seeds": [17,41,73] }\n').encode()
            for name, data in files.items():
                path = fixture / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
            (fixture / 'scripts').mkdir(exist_ok=True)
            for name in ('package.py', 'package_evidence.py', 'source-identity.py'):
                shutil.copy2(ROOT / 'scripts' / name, fixture / 'scripts' / name)
            if (ROOT / '.gitattributes').exists():
                shutil.copy2(ROOT / '.gitattributes', fixture / '.gitattributes')
            result = subprocess.run([sys.executable, 'scripts/package.py'], cwd=fixture, capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            archive_path = Path(report['archive']).resolve()
            self.assertTrue(archive_path.is_relative_to(fixture / 'release'))
            self.assertEqual(report['status'], 'PASS')
            first_bytes = archive_path.read_bytes()
            self.assertEqual(hashlib.sha256(first_bytes).hexdigest(), report['sha256'])
            with zipfile.ZipFile(archive_path) as archive:
                contents = {name: archive.read(name) for name in archive.namelist()}
            for data in contents.values():
                self.assertNotIn(b'PRIVATE_', data)
            for name in ('evidence/results.json', 'evidence/learning-followup-v4/browser/17/trained.onnx', 'evidence/learning-followup-v4/browser/images/owned.png', 'native/target/release/computer-use-native.exe', 'native/target/release/disposable-editor.exe'):
                self.assertEqual(contents['computer-use-runtime/' + name], files[name])
            for name in protocols:
                self.assertEqual(contents['computer-use-runtime/' + name], files[name], name)
            for name in selection.TRAINING_ORIGIN_FILES:
                self.assertEqual(contents['computer-use-runtime/' + name], files[name], name)
            self.assertNotIn(b'\r', contents['computer-use-runtime/scripts/setup.sh'])
            self.assertIn('computer-use-runtime/.gitattributes', contents)
            self.assertEqual(contents['computer-use-runtime/.gitattributes'], (ROOT / '.gitattributes').read_bytes())
            self.assertIn(b'*.sh text eol=lf', contents['computer-use-runtime/.gitattributes'])
            summary = json.loads(contents['computer-use-runtime/evidence/qualification-summary.json'])
            self.assertEqual(summary['status'], 'METADATA_SUMMARY')
            self.assertEqual(summary['reports'][0]['reportedStatus'], 'PASS')
            self.assertEqual((fixture / 'evidence/review-native/results.json').read_bytes(), files['evidence/review-native/results.json'])
            # A later build must preserve the earlier release and its sidecars.
            sidecars = {path: path.read_bytes() for path in (
                archive_path.with_suffix('.zip.sha256'),
                archive_path.with_suffix('.manifest.json'),
                archive_path.with_suffix('.package-check.json'),
            )}
            second = subprocess.run([sys.executable, 'scripts/package.py'], cwd=fixture, capture_output=True, text=True, timeout=20)
            self.assertEqual(second.returncode, 0, second.stderr)
            second_path = Path(json.loads(second.stdout)['archive']).resolve()
            self.assertTrue(second_path.is_relative_to(fixture / 'release'))
            self.assertNotEqual(second_path, archive_path)
            self.assertTrue(second_path.is_file())
            self.assertEqual(archive_path.read_bytes(), first_bytes)
            for path, data in sidecars.items():
                self.assertEqual(path.read_bytes(), data)

    def test_summary_omits_nested_data_commands_errors_and_untrusted_identity(self):
        parent = ROOT / 'evidence/completion/repair-tests/package-privacy'
        parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='summary-fixture-', dir=parent) as temporary:
            fixture = Path(temporary).resolve()
            self.assertTrue(fixture.is_relative_to(parent.resolve()))
            path = fixture / 'evidence/completion/native/results.json'
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({'status': 'FAIL', 'sourceStable': False, 'windows': ['PRIVATE_TITLE'], 'error': 'PRIVATE_ERROR', 'checks': [{'exitCode': 1, 'command': ['PRIVATE_ARGUMENT']}], 'sourceBefore': {'head': 'PRIVATE_HEAD', 'sha256': 'PRIVATE_HASH', 'files': ['PRIVATE_FILE']}}))
            summary = selection.qualification_summary(fixture)
            self.assertNotIn('PRIVATE_', json.dumps(summary))
            self.assertEqual(summary['reports'][0]['reportedStatus'], 'FAIL')
            self.assertEqual(summary['reports'][0]['commandExitCodes'], [1])
            self.assertFalse(summary['reports'][0]['sourceStable'])
            self.assertNotIn('sourceBefore', summary['reports'][0])

    def test_selection_rejects_private_paths_and_traversal(self):
        for name in ('evidence/completion/anything.json', 'evidence/review-native/results.json', 'evidence/paint.json', 'evidence/commands-private.log', 'evidence/learning-followup-v1/native/raw.bmp', 'evidence/learning-followup-v4/browser/../../private.json'):
            self.assertFalse(selection.evidence_allowed(name), name)
        self.assertTrue(selection.evidence_allowed('evidence/learning-followup-v4/browser/17/trained.onnx'))
        for name in selection.TRAINING_ORIGIN_FILES:
            self.assertTrue(selection.evidence_allowed(name), name)
        for name in ('private-inspection.json', '.evaluator.key', 'sources/learner/other.py'):
            self.assertFalse(selection.evidence_allowed('evidence/learning-followup-v4-training-origin-v1/' + name), name)


if __name__ == '__main__':
    unittest.main()
