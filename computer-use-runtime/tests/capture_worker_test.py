"""Real Linux process-boundary faults. Image responses are explicit doubles."""
import json
import ctypes
import os
from pathlib import Path
import sys
import signal
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native/unix"))
import capture_worker
from capture_worker import PipeWireCapture, SETTLED_STOP


@unittest.skipUnless(sys.platform == 'linux', 'Actual passed-FD capture child requires Linux')
class CaptureWorkerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='cur-capture-boundary-')
        self.pid = Path(self.directory.name) / 'child.json'
        self.fd = os.open(os.devnull, os.O_RDONLY)
        self.capture = None
        # This disposable test process adopts only its own deliberately
        # orphaned fault actors so its negative-case cleanup can reap them.
        self.library = ctypes.CDLL(None,use_errno=True)
        self.original_subreaper = ctypes.c_int()
        self.assertEqual(self.library.prctl(37,ctypes.byref(self.original_subreaper),0,0,0),0)
        self.assertEqual(self.library.prctl(36,1,0,0,0),0)
    def tearDown(self):
        if self.capture:
            try: self.capture.close()
            except RuntimeError: pass
        os.close(self.fd)
        self.directory.cleanup()
        self.library.prctl(36,self.original_subreaper.value,0,0,0)
    def command(self, mode):
        return [sys.executable, str(Path(__file__).resolve().parents[1] / 'fixtures/pipewire-capture-fault.py'), mode, str(self.pid)]
    def create(self, mode, **kwargs):
        self.capture = PipeWireCapture(self.fd, 33, worker_command=self.command(mode), **kwargs)
        return self.capture
    def settled(self):
        value = json.loads(self.pid.read_text())
        self.assertNotEqual(value['parent'], os.getpid())  # Owned subreaper guardian.
        self.assertEqual(value['owner'],os.getpid())
        self.assertFalse(Path('/proc', str(value['pid'])).exists(), 'Exact owned child must be reaped')
        self.assertFalse(Path('/proc', str(value['parent'])).exists(), 'Exact owned guardian must be reaped')
        descendant = self.pid.with_suffix('.descendant')
        if descendant.exists(): self.assertFalse(Path('/proc',descendant.read_text()).exists(), 'Detached child must be reaped')
        os.fstat(self.fd)  # Parent retains the portal FD obligation.
    def test_hung_start_is_killed_and_reaped_within_bound(self):
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'deadline'): self.create('hang-start', timeout_ms=1000)
        self.assertTrue(self.pid.with_suffix('.started').exists(), 'Exercise the actual startup hang')
        self.assertLess(time.monotonic()-started, 2)
        self.settled()
    def test_pipe_creation_failure_closes_both_owned_sockets(self):
        sockets = capture_worker.socket.socketpair()
        with patch.object(capture_worker.socket,'socketpair',return_value=sockets), patch.object(capture_worker.os,'pipe',side_effect=OSError('Pipe creation failed')):
            with self.assertRaisesRegex(OSError,'Pipe creation failed'): self.create('cached',timeout_ms=1000)
        self.assertEqual([stream.fileno() for stream in sockets],[-1,-1])
        self.assertFalse(self.pid.exists()); os.fstat(self.fd)
    def test_cancelled_start_does_not_leave_a_background_capture(self):
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'cancelled'):
            self.create('hang-start', timeout_ms=2000, cancelled=lambda: self.pid.with_suffix('.started').exists())
        self.assertTrue(self.pid.with_suffix('.started').exists())
        self.assertLess(time.monotonic()-started, 2)
        self.settled()
    def test_actor_exit_cannot_leave_detached_fd_owner_alive(self):
        with self.assertRaises(RuntimeError): self.create('double-fork-exit',timeout_ms=1000)
        self.assertTrue(self.pid.with_suffix('.descendant').exists())
        self.settled()
    def test_hung_frame_closes_channel_and_reaps_child(self):
        capture = self.create('hang-frame', timeout_ms=1000)
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'deadline'): capture.image(50)
        self.assertLess(time.monotonic()-started, 1.5)
        self.assertTrue(capture.closed)
        self.assertEqual(capture.process.returncode, SETTLED_STOP)
        self.assertTrue(capture.terminal['descendantsSettled'])
        self.settled()
        capture.close()  # Operation failure does not erase proven settlement.
        self.assertIsNone(capture.stream); self.assertFalse(capture.cleanup_errors)
        replacement = self.create('cached',timeout_ms=1000)
        self.assertEqual(replacement.image(50).getpixel((0,0)),(255,0,0))
        replacement.close(); self.settled()
    def test_failed_guardian_cannot_claim_cleanup_or_allow_later_close(self):
        capture = self.create('kill-guardian',timeout_ms=1000)
        try:
            with self.assertRaisesRegex(RuntimeError,'settlement unverified'): capture.poll()
            self.assertIsNone(capture.terminal)
            with self.assertRaisesRegex(RuntimeError,'settlement unverified'): capture.close()
        finally:
            # The armed PDEATHSIG kills the direct actor. The test only reaps
            # its adopted zombie. A missing guardian terminal still fails.
            actor = json.loads(self.pid.read_text())['pid']
            deadline = time.monotonic()+2
            while True:
                result,status = os.waitpid(actor,os.WNOHANG)
                if result:
                    self.assertTrue(os.WIFSIGNALED(status)); self.assertEqual(os.WTERMSIG(status),signal.SIGKILL)
                    break
                self.assertLess(time.monotonic(),deadline,'Guardian death must kill the direct actor')
                time.sleep(.01)
        self.settled()
    def test_actor_bootstrap_rejects_changed_guardian_before_fault_program(self):
        actor = subprocess.Popen([sys.executable,capture_worker.__file__,'--actor',str(os.getpid()+1000000),json.dumps(self.command('cached'))],
            stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        stdout,stderr = actor.communicate(timeout=2)
        self.assertNotEqual(actor.returncode,0); self.assertIn(b'guardian changed',stderr)
        self.assertFalse(self.pid.exists()); os.fstat(self.fd)
    def test_owner_death_settles_hung_actor_and_guardian(self):
        owner = subprocess.Popen([*self.command('owner-death'),str(self.fd)],pass_fds=(self.fd,),
            start_new_session=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        stdout,stderr = owner.communicate(timeout=4)
        self.assertEqual(owner.returncode,0,(stdout,stderr))
        self.assertTrue(self.pid.with_suffix('.frame').exists())
        value = json.loads(self.pid.read_text()); self.assertEqual(value['owner'],owner.pid)
        deadline = time.monotonic()+2
        while Path('/proc',str(value['parent'])).exists() or Path('/proc',str(value['pid'])).exists():
            try:
                while os.waitpid(-1,os.WNOHANG)[0]: pass
            except ChildProcessError: pass
            self.assertLess(time.monotonic(),deadline,'Parent death must not leave FD owners alive')
            time.sleep(.01)
        os.fstat(self.fd)
    def test_hung_close_is_not_acknowledged_as_success(self):
        capture = self.create('hang-close', timeout_ms=1000)
        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'close failed'): capture.close()
        self.assertLess(time.monotonic()-started, 1.5)
        self.settled()
    def test_close_ack_before_actor_cleanup_failure_is_not_success(self):
        capture = self.create('close-finally-fail',timeout_ms=1000)
        with self.assertRaisesRegex(RuntimeError,'cleanup did not complete'): capture.close()
        self.assertEqual(capture.terminal['outcome'],'stopped')
        self.assertEqual(capture.terminal['actorExitCode'],1)
        self.settled()
        capture.close()  # A later explicit settlement can acknowledge no owners.
    def test_failed_terminal_fd_close_is_retained_and_retried_explicitly(self):
        capture = self.create('cached',timeout_ms=1000)
        terminal_fd = capture.terminal_fd; close = os.close
        def fail_terminal(descriptor):
            if descriptor == terminal_fd: raise OSError('Terminal FD close injected failure')
            close(descriptor)
        with patch.object(capture_worker.os,'close',side_effect=fail_terminal):
            with self.assertRaisesRegex(RuntimeError,'terminal FD close failed'): capture.close()
        self.assertTrue(capture.terminal['descendantsSettled'])
        self.assertEqual(capture.terminal_fd,terminal_fd); os.fstat(terminal_fd)
        self.assertTrue(capture.cleanup_errors)
        capture.close()
        self.assertIsNone(capture.terminal_fd); self.assertFalse(capture.cleanup_errors)
        self.assertTrue(any('Terminal FD close injected failure' in row for row in capture.cleanup_history))
        with self.assertRaises(OSError): os.fstat(terminal_fd)
        self.settled()
    def test_oversized_header_and_wrong_receipt_ids_fail_before_image(self):
        for mode, error in [('oversize','size rejected'),('wrong-id','identity rejected')]:
            with self.subTest(mode=mode):
                with self.assertRaisesRegex(RuntimeError,error): self.create(mode,timeout_ms=1000)
                self.settled()
    def test_frame_bytes_and_metadata_fail_closed(self):
        for mode, error in [('bad-pixels','dimensions/bytes'),('bad-metadata','metadata rejected')]:
            with self.subTest(mode=mode):
                capture = self.create(mode,timeout_ms=1000)
                with self.assertRaisesRegex(RuntimeError,error): capture.image(50)
                self.assertTrue(capture.closed); self.settled()
    def test_pixels_cache_time_and_parent_fd_remain_bound(self):
        capture = self.create('cached',timeout_ms=1000)
        image = capture.image(50)
        self.assertEqual(image.size,(2,2)); self.assertEqual(image.getpixel((0,0)),(255,0,0))
        self.assertTrue(capture.metadata['pixelFrameCached'])
        self.assertEqual(capture.metadata['pixelCapturedAt'],123)
        capture.poll(); capture.close(); self.settled()


if __name__ == '__main__': unittest.main()
