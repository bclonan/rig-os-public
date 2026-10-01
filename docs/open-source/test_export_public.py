"""Exercise exporter privacy and ownership using disposable sentinel files."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("reviewed_public_exporter", Path(__file__).with_name("export_public.py"))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)

WINDOWS_FIXTURE_ROOT = "C:" + "\\" + "Users\\private-owner"
SLASH_FIXTURE_ROOT = "C:" + "/Users/private-owner"


class ExportPublicTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="rig-export-sentinels-")
        self.addCleanup(temporary.cleanup)
        self.parent = Path(temporary.name)
        self.root = self.parent / "source"
        self.root.mkdir()
        self.destination = self.parent / "public"
        self.names = []
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(exporter, "ROOT", self.root).start()
        mock.patch.object(exporter, "candidates", side_effect=lambda: sorted(self.names)).start()
        mock.patch.object(exporter.subprocess, "check_output", return_value="a" * 40 + "\n").start()

    def put(self, name, data=b"controlled fixture"):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        self.names.append(name)
        return path

    def export(self, **options):
        return exporter.export_public(self.destination, **options)

    def manifest(self):
        return json.loads((self.destination / "docs/open-source/EXPORT_MANIFEST.json").read_text())

    def test_private_sentinels_are_absent_and_source_bytes_stay_exact(self):
        source = b"export const fixture = 123;\n"
        self.put("computer-use-runtime/src/example.ts", source)
        self.put("docs/open-source/EVIDENCE.md", b"# Evidence\n")
        private = [
            "computer-use-runtime/.data/service/service.token",
            "computer-use-runtime/src/private.key",
            "computer-use-runtime/src/private.pem",
            "computer-use-runtime/src/private.p12",
            "computer-use-runtime/src/private.pfx",
            "computer-use-runtime/src/id_rsa",
            "computer-use-runtime/src/id_ed25519",
            "computer-use-runtime/src/credentials.json",
            "computer-use-runtime/src/session.sqlite",
            "computer-use-runtime/src/session.sqlite-wal",
            "computer-use-runtime/src/session.sqlite3-shm",
            "computer-use-runtime/src/session.db-journal",
            "computer-use-runtime/src/debug.log",
            "computer-use-runtime/src/.env.production",
            "computer-use-runtime/evidence/completion/private.png",
            "docs/open-source/review-console.png",
            "docs/open-source/private-notes.md",
            "docs/open-source/verification-logs/check.log",
        ]
        for name in private:
            self.put(name, b"PRIVATE_SENTINEL_9f7253")
        self.export()
        for name in private:
            self.assertFalse((self.destination / name).exists(), name)
        self.assertEqual((self.destination / "computer-use-runtime/src/example.ts").read_bytes(), source)
        self.assertEqual((self.root / "computer-use-runtime/src/example.ts").read_bytes(), source)
        for path in self.destination.rglob("*"):
            if path.is_file():
                self.assertNotIn(b"PRIVATE_SENTINEL_9f7253", path.read_bytes())

    def test_default_excludes_plain_slash_and_json_escaped_frozen_user_paths(self):
        variants = [
            (SLASH_FIXTURE_ROOT + "/Documents/project/source.py").encode(),
            (WINDOWS_FIXTURE_ROOT + "\\Documents\\project\\source.py").encode(),
            json.dumps({"source": WINDOWS_FIXTURE_ROOT + "\\Documents\\project\\source.py"}).encode(),
        ]
        for index, data in enumerate(variants):
            self.put(f"computer-use-runtime/evidence/learning-followup-v4/browser/private-{index}.json", data)
        self.put("docs/open-source/EVIDENCE.md")
        self.export()
        manifest = self.manifest()
        self.assertEqual(len(manifest["omittedPrivatePathFiles"]), 3)
        for name in manifest["omittedPrivatePathFiles"]:
            self.assertFalse((self.destination / name).exists())
            self.assertEqual((self.root / name).read_bytes(), variants[int(Path(name).stem.split("-")[-1])])

    def test_portable_preparation_is_private_and_preserves_original_frozen_bytes(self):
        name = "computer-use-runtime/evidence/results.json"
        data = json.dumps({"source": WINDOWS_FIXTURE_ROOT + "\\Documents\\project\\source.py"}).encode()
        original = self.put(name, data)
        self.put("docs/open-source/EVIDENCE.md")
        result = self.export(prepare_portable_evidence=True)
        self.assertFalse(result["publicationReady"])
        self.assertEqual(result["pendingPortableEvidenceFiles"], 1)
        self.assertEqual(self.manifest()["pendingPortableEvidence"], [name])
        self.assertEqual((self.destination / name).read_bytes(), data)
        self.assertEqual(original.read_bytes(), data)

    def test_existing_destination_is_never_overwritten(self):
        self.destination.mkdir()
        sentinel = self.destination / "retain.txt"
        sentinel.write_bytes(b"existing independent project")
        with self.assertRaisesRegex(ValueError, "new directory"):
            self.export()
        self.assertEqual(sentinel.read_bytes(), b"existing independent project")
        self.assertEqual(list(self.destination.iterdir()), [sentinel])

    def test_destination_inside_source_is_refused(self):
        for destination in [self.root, self.root / "new"]:
            with self.assertRaisesRegex(ValueError, "outside"):
                exporter.export_public(destination)
        self.assertFalse((self.root / "new").exists())

    def test_private_document_json_fails_before_creating_destination(self):
        self.put("docs/system-review/CLOSURE.json", json.dumps({"root": WINDOWS_FIXTURE_ROOT + "\\project"}).encode())
        with self.assertRaisesRegex(RuntimeError, "Private path"):
            self.export()
        self.assertFalse(self.destination.exists())

    def test_private_host_document_metadata_fails_before_creating_destination(self):
        self.put("docs/open-source/console-command.json", json.dumps({"detail": [{"host_name": socket.gethostname()}]}).encode())
        with self.assertRaisesRegex(RuntimeError, "machine metadata"):
            self.export()
        self.assertFalse(self.destination.exists())

    def test_outside_resolution_is_refused(self):
        self.put("computer-use-runtime/src/owned.ts")
        outside = self.parent / "outside.ts"
        outside.write_bytes(b"private outside source")
        real_resolve = Path.resolve
        def resolve(path, *args, **kwargs):
            if path == self.root / "computer-use-runtime/src/owned.ts":
                return outside
            return real_resolve(path, *args, **kwargs)
        with mock.patch.object(Path, "resolve", resolve):
            with self.assertRaisesRegex(RuntimeError, "outside the checkout"):
                self.export()
        self.assertFalse(self.destination.exists())

    def test_source_junction_ancestor_is_refused(self):
        source = self.put("computer-use-runtime/src/owned.ts")
        with mock.patch.object(Path, "is_junction", lambda path: path == source.parent, create=True):
            with self.assertRaisesRegex(RuntimeError, "junction"):
                self.export()
        self.assertFalse(self.destination.exists())

    def test_destination_junction_ancestor_is_refused(self):
        self.destination = self.parent / "junction-parent/new-export"
        with mock.patch.object(Path, "is_junction", lambda path: path == self.destination.parent, create=True):
            with self.assertRaisesRegex(RuntimeError, "junction"):
                self.export()
        self.assertFalse(self.destination.exists())

    def test_source_symlink_detection_is_required_when_host_creation_is_unavailable(self):
        source = self.put("computer-use-runtime/src/owned.ts")
        with mock.patch.object(Path, "is_symlink", lambda path: path == source):
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                self.export()
        self.assertFalse(self.destination.exists())

    def test_source_file_symlink_is_refused(self):
        outside = self.parent / "outside.ts"
        outside.write_bytes(b"PRIVATE_OUTSIDE_SENTINEL")
        link = self.root / "computer-use-runtime/src/linked.ts"
        link.parent.mkdir(parents=True)
        try:
            os.symlink(outside, link)
        except OSError as error:
            self.skipTest("Host does not permit disposable symlink creation: " + str(error.errno))
        self.names.append("computer-use-runtime/src/linked.ts")
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            self.export()
        self.assertFalse(self.destination.exists())

    def test_source_directory_symlink_is_refused(self):
        outside = self.parent / "outside"
        outside.mkdir()
        (outside / "linked.ts").write_bytes(b"PRIVATE_OUTSIDE_SENTINEL")
        link = self.root / "computer-use-runtime/src"
        link.parent.mkdir(parents=True)
        try:
            os.symlink(outside, link, target_is_directory=True)
        except OSError as error:
            self.skipTest("Host does not permit disposable symlink creation: " + str(error.errno))
        self.names.append("computer-use-runtime/src/linked.ts")
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            self.export()
        self.assertFalse(self.destination.exists())

    def test_key_and_database_name_checks_ignore_case(self):
        for name in ["src/PRIVATE.KEY", "src/SESSION.SQLITE-WAL", "src/SESSION.DB-SHM", "src/ID_RSA"]:
            self.assertFalse(exporter.allowed("computer-use-runtime/" + name))
        self.assertFalse(exporter.allowed("../outside.ts"))
        self.assertFalse(exporter.allowed(""))
        self.assertTrue(exporter.allowed("computer-use-runtime/src/owned.ts"))


if __name__ == "__main__":
    unittest.main()
