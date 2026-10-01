"""One isolated Linux subreaper. Never share this process with other jobs."""
import ctypes
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def descendants():
    rows = {}
    for name in os.listdir('/proc'):
        if not name.isdecimal():
            continue
        try:
            fields = Path('/proc', name, 'stat').read_text().rsplit(')', 1)[1].split()
            rows[int(name)] = (int(fields[1]), fields[0], fields[19])
        except (FileNotFoundError, ProcessLookupError):
            continue
    owned = {os.getpid()}
    while True:
        added = {pid for pid, row in rows.items() if row[0] in owned} - owned
        if not added:
            break
        owned.update(added)
    return {pid: rows[pid] for pid in owned if pid != os.getpid()}


def reap():
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
            if not pid:
                return
        except ChildProcessError:
            return


def signal_owned(pid, identity, requested):
    try:
        descriptor = os.pidfd_open(pid)
    except ProcessLookupError:
        return
    try:
        try:
            current = Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()
        except FileNotFoundError:
            return
        if current[19] != identity:
            return  # The original exited; do not signal a recycled PID.
        try:
            signal.pidfd_send_signal(descriptor, requested)
        except ProcessLookupError:
            pass
    finally:
        os.close(descriptor)


def drain(timeout):
    deadline = time.monotonic() + timeout
    hard_at = time.monotonic() + timeout / 2
    while True:
        reap()
        remaining = descendants()
        if not remaining:
            return
        if time.monotonic() >= deadline:
            raise RuntimeError('Owned Linux descendants did not settle before cleanup deadline')
        requested = signal.SIGKILL if time.monotonic() >= hard_at else signal.SIGTERM
        for pid, (_, state, identity) in remaining.items():
            if state != 'Z':
                signal_owned(pid, identity, requested)
        time.sleep(.02)


def main():
    timeout, cleanup_timeout, metadata, *command = sys.argv[1:]
    timeout, cleanup_timeout = float(timeout), float(cleanup_timeout)
    result = {'exit_code': 1, 'command_pid': None, 'timed_out': False,
              'interrupted': False, 'error': None, 'cleanup_errors': [],
              'ownership': 'linux-subreaper'}
    process = None
    try:
        if sys.platform != 'linux' or not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
            raise RuntimeError('Linux /proc and pidfd ownership are required')
        library = ctypes.CDLL(None, use_errno=True)
        if library.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
            raise OSError(ctypes.get_errno(), 'Cannot own orphaned command descendants')
        enabled = ctypes.c_int()
        if library.prctl(37, ctypes.byref(enabled), 0, 0, 0) != 0 or enabled.value != 1:
            raise RuntimeError('Linux subreaper ownership was not confirmed')
        if descendants():
            raise RuntimeError('The isolated command worker already has children')
        def stop(_signal, _frame):
            raise SystemExit('Owned worker interrupted')
        signal.signal(signal.SIGTERM, stop)
        ready = Path(metadata).with_suffix('.ready')
        ready.write_text(str(os.getpid()))
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL)
        result['command_pid'] = process.pid
        result['exit_code'] = process.wait(timeout=timeout)
        if descendants():
            result['error'] = 'Command exited while owned descendants were still running'
    except subprocess.TimeoutExpired:
        result['timed_out'] = True
        result['error'] = 'Command deadline exceeded'
    except (KeyboardInterrupt, SystemExit) as error:
        result['interrupted'] = True
        result['error'] = type(error).__name__ + ': ' + str(error)
    except Exception as error:
        result['error'] = type(error).__name__ + ': ' + str(error)
    finally:
        try:
            drain(cleanup_timeout)
        except BaseException as error:
            result['cleanup_errors'].append(type(error).__name__ + ': ' + str(error))
        if process:
            try:
                process.wait(timeout=.01)
            except BaseException as error:
                result['cleanup_errors'].append('Owned command settlement: ' + str(error))
        if result['error'] or result['cleanup_errors']:
            result['exit_code'] = 1
        path = Path(metadata)
        temporary = path.with_suffix('.pending')
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(result, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    return 0 if result['exit_code'] == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
