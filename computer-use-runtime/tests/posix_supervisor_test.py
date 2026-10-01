"""Actual Linux detached/double-fork descendants in an isolated subreaper."""
import importlib.util
import json
from pathlib import Path
import os
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('linux_supervisor', Path(__file__).resolve().parents[1] / 'scripts/process_supervisor.py')
supervisor = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = supervisor
spec.loader.exec_module(supervisor)


@unittest.skipUnless(sys.platform == 'linux', 'Linux pidfd/subreaper ownership')
class PosixSupervisorTests(unittest.TestCase):
    def detached(self, parent_exits, double_fork, ignore_term=False):
        with tempfile.TemporaryDirectory(prefix='cur-linux-owned-') as directory:
            pidfile = Path(directory) / 'detached.json'
            child = "import os,time,json,pathlib,sys,signal; "
            if double_fork:
                child += "os.setsid(); pid=os.fork();\nif pid: os._exit(0)\n"
            if ignore_term:
                child += "signal.signal(signal.SIGTERM,signal.SIG_IGN); "
            child += "pathlib.Path(sys.argv[1]+'.pending').write_text(json.dumps(os.getpid())); os.replace(sys.argv[1]+'.pending',sys.argv[1]); time.sleep(30)"
            parent = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c'," + repr(child) + ",sys.argv[1]],start_new_session=" + str(not double_fork) + "); print('retained-before-timeout',flush=True); time.sleep(" + ('.3' if parent_exits else '30') + ")"
            result = supervisor.run_command([sys.executable, '-c', parent, str(pidfile)], cwd=directory, timeout=.8, cleanup_timeout=2)
            self.assertTrue(pidfile.is_file(), result.output.decode(errors='replace'))
            detached = json.loads(pidfile.read_text())
            self.assertEqual(result.exit_code, 1)
            self.assertEqual(result.cleanup_errors, [])
            self.assertEqual(result.timed_out, not parent_exits)
            self.assertEqual(result.ownership, 'linux-subreaper')
            self.assertIn(b'retained-before-timeout', result.output)
            self.assertFalse(Path('/proc', str(detached)).exists(), 'Detached descendant was not settled and reaped')

    def test_detached_timeout(self): self.detached(False, False)
    def test_detached_after_parent_exit(self): self.detached(True, False)
    def test_double_fork_after_parent_exit(self): self.detached(True, True)
    def test_double_fork_timeout_with_term_refusal(self): self.detached(False, True, True)


if __name__ == '__main__':
    unittest.main()
