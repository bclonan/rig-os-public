"""Check path removal and hash dependency settlement on synthetic metadata."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("publication_normalizer", Path(__file__).with_name("normalize_public_evidence.py"))
normalizer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(normalizer)


class PortableEvidenceTests(unittest.TestCase):
    def test_normal_and_json_escaped_paths_resolve_to_neutral_root(self):
        root = Path("C:" + "/Users/private-owner/Documents/GitHub/rig-os/computer-use-runtime")
        plain = root.as_posix().encode()
        actual = normalizer.replace_root(b'{"image":"' + plain + b'/images/test.png"}', root)
        self.assertNotIn(b"private-owner", actual)
        self.assertIn(b"/PUBLIC_WORKSPACE/computer-use-runtime/images/test.png", actual)

    def test_hash_updates_follow_multiple_levels_without_changing_payloads(self):
        leaf = b'{"path":"private"}\n'
        parent = ('{"input":"' + normalizer.digest(leaf) + '"}\n').encode()
        seal = ('{"result":"' + normalizer.digest(parent) + '"}\n').encode()
        originals = {"leaf": leaf, "parent": parent, "seal": seal}
        transformed = {**originals, "leaf": b'{"path":"portable"}\n'}
        result = normalizer.remap_hashes(originals, transformed)
        self.assertEqual(result["leaf"], transformed["leaf"])
        self.assertIn(normalizer.digest(result["leaf"]).encode(), result["parent"])
        self.assertIn(normalizer.digest(result["parent"]).encode(), result["seal"])
        self.assertEqual(originals["leaf"], leaf)

    def test_windows_backslashes_and_repeated_json_escapes_are_removed(self):
        root = Path("C:" + "\\" + r"Users\private-owner\Documents\GitHub\rig-os\computer-use-runtime")
        text = str(root) + r"\images\owned.png"
        for _ in range(5):
            actual = normalizer.replace_root(text.encode(), root)
            self.assertNotIn(b"private-owner", actual)
            self.assertIn(b"/PUBLIC_WORKSPACE/computer-use-runtime", actual)
            text = json.dumps(text)[1:-1]

    def test_traversal_and_hardlinks_reject_before_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name in ["../outside", "C:/outside", "/outside"]:
                with self.assertRaises(ValueError):
                    normalizer.checked_path(root, name)
            path = root / "owned.json"
            path.write_text("{}")
            __import__("os").link(path, root / "shared.json")
            with self.assertRaises(ValueError):
                normalizer.checked_path(root, "owned.json")

    def test_machine_metadata_changes_only_exact_identity_fields(self):
        raw = b'{"hostId":"ABC","text":"ABC sample","host":"ABC","digest":"abc123"}'
        actual = normalizer.replace_host_metadata(raw, "ABC")
        self.assertEqual(json.loads(actual), {"hostId": "public-fixture-host", "text": "ABC sample", "host": "public-fixture-host", "digest": "abc123"})


if __name__ == "__main__":
    unittest.main()
