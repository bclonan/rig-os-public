"""Run one owned command, retain partial bytes, and settle its whole process tree."""
from dataclasses import dataclass, field
import ctypes
import os
import json
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import sys
import threading


@dataclass
class CommandResult:
    exit_code: int = 1
    output: bytes = b''
    pid: int | None = None
    command_pid: int | None = None
    ownership: str | None = None
    timed_out: bool = False
    interrupted: bool = False
    error: str | None = None
    cleanup_errors: list[str] = field(default_factory=list)


class _WindowsJob:
    """Assign a suspended child before it can create an untracked descendant."""
    def __init__(self):
        from ctypes import wintypes as w
        class Limits(ctypes.Structure):
            _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64),
                        ('flags', w.DWORD), ('minimum', ctypes.c_size_t),
                        ('maximum', ctypes.c_size_t), ('active_limit', w.DWORD),
                        ('affinity', ctypes.c_size_t), ('priority', w.DWORD),
                        ('scheduling', w.DWORD)]
        class Extended(ctypes.Structure):
            _fields_ = [('basic', Limits), ('io', ctypes.c_uint64 * 6),
                        ('process_memory', ctypes.c_size_t), ('job_memory', ctypes.c_size_t),
                        ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]
        class Accounting(ctypes.Structure):
            _fields_ = [('times', ctypes.c_int64 * 4), ('faults', w.DWORD),
                        ('total', w.DWORD), ('active', w.DWORD), ('terminated', w.DWORD)]
        class CompletionPort(ctypes.Structure):
            _fields_ = [('key', ctypes.c_void_p), ('port', w.HANDLE)]
        self.accounting = Accounting
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = w.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        self.kernel.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p]
        self.kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.kernel.TerminateJobObject.argtypes = [w.HANDLE, w.UINT]
        self.kernel.CloseHandle.argtypes = [w.HANDLE]
        self.kernel.CreateIoCompletionPort.argtypes = [w.HANDLE, w.HANDLE, ctypes.c_size_t, w.DWORD]
        self.kernel.CreateIoCompletionPort.restype = w.HANDLE
        self.kernel.GetQueuedCompletionStatus.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD), ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_void_p), w.DWORD]
        self.port = None
        self.assigned = False
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())
        limits = Extended()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.kernel.SetInformationJobObject(self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())
        self.port = self.kernel.CreateIoCompletionPort(ctypes.c_void_p(-1), None, 0, 1)
        if not self.port:
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())
        association = CompletionPort(1, self.port)
        if not self.kernel.SetInformationJobObject(self.handle, 7, ctypes.byref(association), ctypes.sizeof(association)):
            self.close()
            raise ctypes.WinError(ctypes.get_last_error())

    def start(self, process):
        if not self.kernel.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise ctypes.WinError(ctypes.get_last_error())
        self.assigned = True
        native = ctypes.WinDLL('ntdll')
        native.NtResumeProcess.argtypes = [ctypes.c_void_p]
        native.NtResumeProcess.restype = ctypes.c_long
        if native.NtResumeProcess(int(process._handle)) < 0:
            raise RuntimeError('Could not resume the owned job process')

    def active(self):
        info = self.accounting()
        if not self.kernel.QueryInformationJobObject(self.handle, 1, ctypes.byref(info), ctypes.sizeof(info), None):
            raise ctypes.WinError(ctypes.get_last_error())
        return info.active > 0

    def terminate(self):
        if not self.kernel.TerminateJobObject(self.handle, 33):
            raise ctypes.WinError(ctypes.get_last_error())

    def wait_empty(self, deadline):
        from ctypes import wintypes as w
        if not self.assigned:
            return
        # Accounting can reach zero before the process-exit notification. Wait
        # for the job's completion event rather than mistaking a kill request
        # for settled descendants.
        while time.monotonic() < deadline:
            message, key, process_id = w.DWORD(), ctypes.c_size_t(), ctypes.c_void_p()
            remaining = max(1, int((deadline - time.monotonic()) * 1000))
            if not self.kernel.GetQueuedCompletionStatus(self.port, ctypes.byref(message), ctypes.byref(key), ctypes.byref(process_id), remaining):
                raise ctypes.WinError(ctypes.get_last_error())
            if key.value != 1:
                raise RuntimeError('Unexpected owned job completion key')
            if message.value == 4:  # JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO
                return
        raise RuntimeError('Owned job exit notification exceeded cleanup deadline')

    def close(self):
        errors = []
        if self.handle:
            handle, self.handle = self.handle, None
            if not self.kernel.CloseHandle(handle):
                errors.append(ctypes.WinError(ctypes.get_last_error()))
        if self.port:
            port, self.port = self.port, None
            if not self.kernel.CloseHandle(port):
                errors.append(ctypes.WinError(ctypes.get_last_error()))
        if errors:
            raise RuntimeError('; '.join(str(error) for error in errors))


def _group_active(pid):
    # Linux zombies cannot execute or hold input. A container's PID 1 may not reap
    # them immediately, so do not confuse them with a still-running descendant.
    if os.path.isdir('/proc'):
        for name in os.listdir('/proc'):
            if not name.isdecimal():
                continue
            try:
                with open('/proc/' + name + '/stat') as stream:
                    fields = stream.read().rsplit(')', 1)[1].split()
                if int(fields[2]) == pid and fields[0] != 'Z':
                    return True
            except (OSError, ValueError, IndexError):
                continue
        return False
    try:
        os.killpg(pid, 0)
        return True
    except ProcessLookupError:
        return False


def _run_linux(command, *, cwd, timeout, cleanup_timeout, env):
    result = CommandResult(ownership='linux-subreaper')
    process = None
    descriptor = None
    with tempfile.TemporaryDirectory(prefix='cur-owned-command-') as directory, tempfile.TemporaryFile() as output:
        metadata = Path(directory) / 'terminal.json'
        worker = Path(__file__).with_name('posix_command_worker.py')
        try:
            process = subprocess.Popen([sys.executable, str(worker), str(timeout), str(cleanup_timeout), str(metadata), *command],
                                       cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            result.pid = process.pid
            descriptor = os.pidfd_open(process.pid)
            # The worker applies the original command limit and owns cleanup.
            # This outer bound detects a failed worker, not a command retry.
            process.wait(timeout=timeout + cleanup_timeout + 2)
        except (KeyboardInterrupt, SystemExit) as error:
            result.interrupted = True
            result.error = type(error).__name__ + ': ' + str(error)
        except subprocess.TimeoutExpired:
            result.timed_out = True
            result.error = 'Owned Linux worker exceeded its outer deadline'
        except Exception as error:
            result.error = type(error).__name__ + ': ' + str(error)
        finally:
            if process and process.poll() is None:
                try:
                    if descriptor is None:
                        raise RuntimeError('Owned Linux worker has no retained pidfd')
                    ready_deadline = time.monotonic() + min(1, cleanup_timeout / 2)
                    ready = metadata.with_suffix('.ready')
                    while not ready.exists() and process.poll() is None and time.monotonic() < ready_deadline:
                        time.sleep(.01)
                    if process.poll() is None and (not ready.is_file() or ready.read_text() != str(process.pid)):
                        raise RuntimeError('Owned Linux worker did not establish cooperative cleanup')
                    signal.pidfd_send_signal(descriptor, signal.SIGTERM)
                    process.wait(timeout=cleanup_timeout + 1)
                except BaseException as error:
                    result.cleanup_errors.append('Owned worker cooperative settlement: ' + str(error))
                    try:
                        if descriptor is not None:
                            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                        process.wait(timeout=1)
                    except BaseException as forced_error:
                        result.cleanup_errors.append('Owned worker forced settlement: ' + str(forced_error))
            if descriptor is not None:
                os.close(descriptor)
            if metadata.is_file():
                try:
                    terminal = json.loads(metadata.read_text())
                    expected = {'exit_code', 'command_pid', 'timed_out', 'interrupted', 'error', 'cleanup_errors', 'ownership'}
                    if set(terminal) != expected or terminal['ownership'] != 'linux-subreaper':
                        raise RuntimeError('Owned worker terminal shape rejected')
                    if process.returncode != (0 if terminal['exit_code'] == 0 else 1):
                        raise RuntimeError('Owned worker exit disagrees with its terminal')
                    result.command_pid = terminal['command_pid']
                    result.exit_code = terminal['exit_code']
                    result.timed_out = result.timed_out or terminal['timed_out']
                    result.interrupted = result.interrupted or terminal['interrupted']
                    result.error = result.error or terminal['error']
                    result.cleanup_errors.extend(terminal['cleanup_errors'])
                except Exception as error:
                    result.cleanup_errors.append('Owned worker terminal rejected: ' + str(error))
            else:
                result.cleanup_errors.append('No settled Linux tree receipt; descendant cleanup is unverified')
            output.seek(0)
            result.output = output.read()
    if result.error or result.cleanup_errors:
        result.exit_code = 1
    return result


def run_command(command, *, cwd, timeout, cleanup_timeout=5, env=None):
    if timeout <= 0 or cleanup_timeout <= 0:
        raise ValueError('Command and cleanup deadlines must be positive')
    if os.name != 'nt' and sys.platform != 'linux':
        return CommandResult(error='Tracked command supervision is currently supported on Windows and Linux only; no command started', ownership='unsupported')
    if sys.platform == 'linux':
        previous = None
        install_handler = threading.current_thread() is threading.main_thread()
        if install_handler:
            previous = signal.getsignal(signal.SIGTERM)
            def stop(_signal, _frame):
                raise SystemExit('Command supervisor interrupted')
            signal.signal(signal.SIGTERM, stop)
        try:
            return _run_linux(command, cwd=cwd, timeout=timeout, cleanup_timeout=cleanup_timeout, env=env)
        finally:
            if install_handler:
                signal.signal(signal.SIGTERM, previous)
    result = CommandResult()
    result.ownership = 'windows-job' if os.name == 'nt' else 'posix-process-group'
    process = job = None
    with tempfile.TemporaryFile() as output:
        try:
            if os.name == 'nt':
                job = _WindowsJob()
            process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                       stdout=output, stderr=subprocess.STDOUT,
                                       creationflags=(0x4 | subprocess.CREATE_NEW_PROCESS_GROUP) if job else 0,
                                       start_new_session=not bool(job))
            result.pid = process.pid
            result.command_pid = process.pid
            if job:
                job.start(process)
            result.exit_code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            result.timed_out = True
            result.error = 'Command deadline exceeded'
        except (KeyboardInterrupt, SystemExit) as error:
            result.interrupted = True
            result.error = type(error).__name__ + ': ' + str(error)
        except Exception as error:
            result.error = type(error).__name__ + ': ' + str(error)
        finally:
            cleanup_deadline = time.monotonic() + cleanup_timeout
            if process:
                try:
                    active = job.active() if job else _group_active(process.pid)
                    if active:
                        if not result.error:
                            result.error = 'Command exited while owned descendants were still running'
                        if job:
                            job.terminate()
                        else:
                            os.killpg(process.pid, signal.SIGTERM)
                        started_cleanup = time.monotonic()
                        deadline = cleanup_deadline
                        escalate_at = started_cleanup + cleanup_timeout / 2
                        escalated = bool(job)
                        while (job.active() if job else _group_active(process.pid)):
                            if not escalated and time.monotonic() >= escalate_at:
                                os.killpg(process.pid, signal.SIGKILL)
                                escalated = True
                            if time.monotonic() >= deadline:
                                raise RuntimeError('Owned process tree did not settle before cleanup deadline')
                            time.sleep(.02)
                    if job:
                        job.wait_empty(cleanup_deadline)
                except Exception as error:
                    result.cleanup_errors.append(str(error))
                # Also drain a suspended process if assignment failed before it
                # belonged to the job. This never targets a process by name.
                try:
                    if process.poll() is None:
                        process.kill()
                    process.wait(timeout=max(.001, cleanup_deadline - time.monotonic()))
                except Exception as error:
                    result.cleanup_errors.append('Owned root did not settle: ' + str(error))
            if job:
                try:
                    job.close()
                except Exception as error:
                    result.cleanup_errors.append('Owned job close failed: ' + str(error))
            output.seek(0)
            result.output = output.read()
    if result.error or result.cleanup_errors:
        result.exit_code = 1
    return result
