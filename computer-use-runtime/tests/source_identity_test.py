"""Check standalone release identity without a parent Git checkout."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class StandaloneIdentityTests(unittest.TestCase):
    def setUp(self):
        parent = Path(tempfile.gettempdir()).resolve()
        self.temporary = tempfile.TemporaryDirectory(prefix='cur-source-id-', dir=parent)
        self.root = Path(self.temporary.name).resolve()
        self.assertTrue(self.root.is_relative_to(parent))
        self.assertTrue(self.root.name.startswith('cur-source-id-'))
        self.addCleanup(self.temporary.cleanup)
        try:
            git = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=self.root, capture_output=True)
            self.assertNotEqual(git.returncode, 0, 'Standalone fixture must not inherit Git metadata')
        except FileNotFoundError:
            pass
        (self.root / 'scripts').mkdir()
        shutil.copy2(ROOT / 'scripts/source-identity.py', self.root / 'scripts/source-identity.py')
        (self.root / 'src').mkdir()
        (self.root / 'src/main.ts').write_text('export const value = 7;\n')
        files = ['scripts/source-identity.py', 'src/main.ts']
        digest = hashlib.sha256()
        for name in files:
            sha = hashlib.sha256((self.root / name).read_bytes()).hexdigest()
            digest.update(name.encode() + b'\0' + sha.encode() + b'\n')
        self.identity = {'head': '1' * 40, 'sha256': digest.hexdigest()}
        self.manifest = {'schemaVersion': 1, 'sourceIdentity': self.identity}
        self.write_manifest()

    def write_manifest(self):
        (self.root / 'RELEASE_MANIFEST.json').write_text(json.dumps(self.manifest))

    def run_identity(self):
        return subprocess.run([sys.executable, 'scripts/source-identity.py'], cwd=self.root,
                              capture_output=True, text=True, timeout=10)

    def test_exact_release_bytes_work_without_git(self):
        result = self.run_identity()
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = json.loads(result.stdout)
        self.assertEqual(actual['head'], self.identity['head'])
        self.assertEqual(actual['sha256'], self.identity['sha256'])
        self.assertEqual(actual['headOrigin'], 'release-manifest')
        self.assertEqual([file['path'] for file in actual['files']], ['scripts/source-identity.py', 'src/main.ts'])

    def test_edited_added_and_missing_source_do_not_borrow_release_identity(self):
        original = (self.root / 'src/main.ts').read_bytes()
        for mode in ('edited', 'added', 'deleted'):
            with self.subTest(mode=mode):
                (self.root / 'src/main.ts').write_bytes(original)
                extra = self.root / 'src/extra.ts'
                extra.unlink(missing_ok=True)
                if mode == 'edited': (self.root / 'src/main.ts').write_text('export const value = 8;\n')
                if mode == 'added': extra.write_text('export const injected = true;\n')
                if mode == 'deleted': (self.root / 'src/main.ts').unlink()
                self.assertNotEqual(self.run_identity().returncode, 0)

    def test_absent_or_malformed_release_identity_does_not_create_a_revision(self):
        (self.root / 'RELEASE_MANIFEST.json').unlink()
        self.assertNotEqual(self.run_identity().returncode, 0)
        for value in ({'head': 'made-up', 'sha256': self.identity['sha256']},
                      {'head': self.identity['head'], 'sha256': 'not-a-hash'},
                      {'head': self.identity['head'], 'sha256': '0' * 64}):
            self.manifest['sourceIdentity'] = value
            self.write_manifest()
            self.assertNotEqual(self.run_identity().returncode, 0)


if __name__ == '__main__':
    unittest.main()
