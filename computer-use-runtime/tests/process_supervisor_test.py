"""Owned disposable processes only. No service, browser or native input."""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('process_supervisor', Path(__file__).resolve().parents[1] / 'scripts/process_supervisor.py')
supervisor = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = supervisor
spec.loader.exec_module(supervisor)


class ProcessSupervisorTests(unittest.TestCase):
    def test_exit_and_partial_bytes(self):
        result = supervisor.run_command([sys.executable, '-c', "import sys; sys.stdout.buffer.write(b'raw\\xff\\n'); sys.stdout.flush(); sys.exit(7)"], cwd=Path.cwd(), timeout=3)
        self.assertEqual(result.exit_code, 7)
        self.assertEqual(result.output, b'raw\xff\n')
        self.assertEqual(result.cleanup_errors, [])

    def tree(self, parent_exits):
        with tempfile.TemporaryDirectory(prefix='cur-owned-tree-') as directory:
            pidfile = Path(directory) / 'child.json'
            child = "import time; time.sleep(30)"
            parent = "import subprocess,sys,json,time,os,pathlib; p=subprocess.Popen([sys.executable,'-c'," + repr(child) + "]); pathlib.Path(sys.argv[1]+'.pending').write_text(json.dumps(p.pid)); os.replace(sys.argv[1]+'.pending',sys.argv[1]); print('partial-before-timeout',flush=True); " + ("time.sleep(.5)" if parent_exits else "time.sleep(30)")
            results = []
            thread = threading.Thread(target=lambda: results.append(supervisor.run_command([sys.executable, '-c', parent, str(pidfile)], cwd=directory, timeout=1.2, cleanup_timeout=2)))
            thread.start()
            deadline = time.monotonic() + 1
            handle = None
            try:
                while not pidfile.exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(pidfile.exists(), 'Owned child did not publish its PID')
                child_pid = json.loads(pidfile.read_text())
                if os.name == 'nt':
                    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
                    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
                    kernel.OpenProcess.restype = ctypes.c_void_p
                    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
                    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
                    handle = kernel.OpenProcess(0x100000, False, child_pid)
                    self.assertTrue(handle, 'Could not retain exact owned child handle')
                thread.join(6)
                self.assertFalse(thread.is_alive())
                result = results[0]
                self.assertEqual(result.exit_code, 1)
                self.assertIn(b'partial-before-timeout', result.output)
                self.assertEqual(result.cleanup_errors, [])
                self.assertEqual(result.timed_out, not parent_exits)
                if handle:
                    self.assertEqual(kernel.WaitForSingleObject(handle, 0), 0, 'Owned descendant survived')
                else:
                    self.assertFalse(supervisor._group_active(result.pid))
            finally:
                thread.join(6)
                if handle:
                    kernel.CloseHandle(handle)

    def test_timeout_settles_descendant_and_keeps_partial_output(self):
        self.tree(False)

    def test_parent_exit_does_not_leave_a_descendant(self):
        self.tree(True)

    def test_interruption_drains_owned_root(self):
        real = subprocess.Popen
        class InterruptedProcess(real):
            def wait(self, *args, **kwargs):
                if not getattr(self, 'interrupted_once', False):
                    self.interrupted_once = True
                    raise KeyboardInterrupt('controlled test interruption')
                return super().wait(*args, **kwargs)
        with patch.object(supervisor.subprocess, 'Popen', InterruptedProcess):
            result = supervisor.run_command([sys.executable, '-c', 'import time; time.sleep(30)'], cwd=Path.cwd(), timeout=3)
        self.assertTrue(result.interrupted)
        self.assertEqual(result.exit_code, 1)
        self.assertEqual(result.cleanup_errors, [])

    def test_launch_failure_and_invalid_budget(self):
        result = supervisor.run_command(['cur-absent-owned-command-5e347a'], cwd=Path.cwd(), timeout=1)
        self.assertEqual(result.exit_code, 1)
        self.assertIsNotNone(result.error)
        with self.assertRaises(ValueError):
            supervisor.run_command([sys.executable], cwd=Path.cwd(), timeout=0)

    def test_unsupported_platform_denies_before_launch(self):
        with patch.object(supervisor.sys, 'platform', 'darwin'), patch.object(supervisor.os, 'name', 'posix'), patch.object(supervisor.subprocess, 'Popen') as launch:
            result = supervisor.run_command(['must-not-start'], cwd='.', timeout=1)
        launch.assert_not_called()
        self.assertEqual(result.exit_code, 1)
        self.assertEqual(result.ownership, 'unsupported')
        self.assertIsNone(result.pid)

    @unittest.skipUnless(os.name == 'nt', 'Windows job close fault boundary')
    def test_job_cleanup_error_cannot_report_success(self):
        original = supervisor._WindowsJob.close
        def close_then_fail(job):
            original(job)
            raise RuntimeError('controlled post-close failure')
        with patch.object(supervisor._WindowsJob, 'close', close_then_fail):
            result = supervisor.run_command([sys.executable, '-c', 'print("owned settled")'], cwd=Path.cwd(), timeout=3)
        self.assertEqual(result.exit_code, 1)
        self.assertIn('controlled post-close failure', result.cleanup_errors[0])


if __name__ == '__main__':
    unittest.main()
