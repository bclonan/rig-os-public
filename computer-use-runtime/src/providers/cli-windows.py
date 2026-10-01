"""Run one owned CLI in a kill-on-close Windows Job Object. No shell."""

import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def main():
    if os.name != "nt" or len(sys.argv) != 2:
        raise RuntimeError("CLI supervisor platform or arguments rejected")
    manifest = Path(sys.argv[1])
    if not manifest.is_absolute() or manifest.stat().st_size > 256 * 1024:
        raise RuntimeError("CLI supervisor manifest rejected")
    request = json.loads(manifest.read_text(encoding="utf-8"))
    if set(request) != {"command", "args", "cwd", "timeoutMs"}:
        raise RuntimeError("CLI supervisor contract rejected")
    command, args, cwd = request["command"], request["args"], request["cwd"]
    timeout_ms = request["timeoutMs"]
    if type(timeout_ms) is not int or not 1 <= timeout_ms <= 120000:
        raise RuntimeError("CLI supervisor deadline rejected")
    if not isinstance(command, str) or not Path(command).is_absolute():
        raise RuntimeError("CLI supervisor executable rejected")
    if not isinstance(cwd, str) or not Path(cwd).is_absolute():
        raise RuntimeError("CLI supervisor directory rejected")
    if not isinstance(args, list) or not all(isinstance(item, str) for item in args):
        raise RuntimeError("CLI supervisor arguments rejected")
    command_line = subprocess.list2cmdline([command, *args])
    if len(command_line) > 32766:
        raise RuntimeError("CLI supervisor argument budget exceeded")

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    ULONG_PTR = ctypes.c_size_t
    SIZE_T = ctypes.c_size_t

    class StartupInfo(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("reserved", wintypes.LPWSTR),
                    ("desktop", wintypes.LPWSTR), ("title", wintypes.LPWSTR),
                    ("x", wintypes.DWORD), ("y", wintypes.DWORD),
                    ("x_size", wintypes.DWORD), ("y_size", wintypes.DWORD),
                    ("x_count", wintypes.DWORD), ("y_count", wintypes.DWORD),
                    ("fill", wintypes.DWORD), ("flags", wintypes.DWORD),
                    ("show", wintypes.WORD), ("reserved_size", wintypes.WORD),
                    ("reserved_bytes", ctypes.POINTER(ctypes.c_ubyte)),
                    ("stdin", wintypes.HANDLE), ("stdout", wintypes.HANDLE),
                    ("stderr", wintypes.HANDLE)]

    class ProcessInfo(ctypes.Structure):
        _fields_ = [("process", wintypes.HANDLE), ("thread", wintypes.HANDLE),
                    ("pid", wintypes.DWORD), ("tid", wintypes.DWORD)]

    class BasicLimits(ctypes.Structure):
        _fields_ = [("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                    ("flags", wintypes.DWORD), ("min_working", SIZE_T),
                    ("max_working", SIZE_T), ("active_limit", wintypes.DWORD),
                    ("affinity", ULONG_PTR), ("priority", wintypes.DWORD),
                    ("scheduling", wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in
                    ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [("basic", BasicLimits), ("io", IoCounters),
                    ("process_memory", SIZE_T), ("job_memory", SIZE_T),
                    ("peak_process_memory", SIZE_T), ("peak_job_memory", SIZE_T)]

    class Accounting(ctypes.Structure):
        _fields_ = [("user", ctypes.c_int64), ("kernel", ctypes.c_int64),
                    ("period_user", ctypes.c_int64), ("period_kernel", ctypes.c_int64),
                    ("faults", wintypes.DWORD), ("total", wintypes.DWORD),
                    ("active", wintypes.DWORD), ("terminated", wintypes.DWORD)]

    signatures = {
        "CreateJobObjectW": ([ctypes.c_void_p, wintypes.LPCWSTR], wintypes.HANDLE),
        "SetInformationJobObject": ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD], wintypes.BOOL),
        "QueryInformationJobObject": ([wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p], wintypes.BOOL),
        "AssignProcessToJobObject": ([wintypes.HANDLE, wintypes.HANDLE], wintypes.BOOL),
        "TerminateJobObject": ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
        "GetStdHandle": ([wintypes.DWORD], wintypes.HANDLE),
        "CreateProcessW": ([wintypes.LPCWSTR, wintypes.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
                            wintypes.BOOL, wintypes.DWORD, ctypes.c_void_p, wintypes.LPCWSTR,
                            ctypes.POINTER(StartupInfo), ctypes.POINTER(ProcessInfo)], wintypes.BOOL),
        "ResumeThread": ([wintypes.HANDLE], wintypes.DWORD),
        "WaitForSingleObject": ([wintypes.HANDLE, wintypes.DWORD], wintypes.DWORD),
        "GetExitCodeProcess": ([wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)], wintypes.BOOL),
        "TerminateProcess": ([wintypes.HANDLE, wintypes.UINT], wintypes.BOOL),
        "CloseHandle": ([wintypes.HANDLE], wintypes.BOOL),
    }
    for name, (argument_types, result_type) in signatures.items():
        function = getattr(kernel, name)
        function.argtypes, function.restype = argument_types, result_type

    def checked(value):
        if not value:
            raise RuntimeError("CLI supervisor native operation failed")
        return value

    job = checked(kernel.CreateJobObjectW(None, None))
    process = ProcessInfo()
    try:
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        checked(kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
        startup = StartupInfo()
        startup.cb = ctypes.sizeof(startup)
        startup.flags = 0x100  # STARTF_USESTDHANDLES
        startup.stdin = kernel.GetStdHandle(ctypes.c_uint32(-10).value)
        startup.stdout = kernel.GetStdHandle(ctypes.c_uint32(-11).value)
        startup.stderr = kernel.GetStdHandle(ctypes.c_uint32(-12).value)
        # Child cannot run or create descendants until assignment to our private job succeeds.
        checked(kernel.CreateProcessW(command, ctypes.create_unicode_buffer(command_line), None, None,
                                      True, 0x08000004, None, cwd, ctypes.byref(startup), ctypes.byref(process)))
        if not kernel.AssignProcessToJobObject(job, process.process):
            kernel.TerminateProcess(process.process, 125)
            kernel.WaitForSingleObject(process.process, 5000)
            raise RuntimeError("CLI supervisor job assignment failed")
        if kernel.ResumeThread(process.thread) == 0xFFFFFFFF:
            raise RuntimeError("CLI supervisor resume failed")
        # This deadline survives a crashed coordinator, whose JS timer would disappear.
        wait_result = kernel.WaitForSingleObject(process.process, timeout_ms)
        if wait_result not in (0, 258):
            raise RuntimeError("CLI supervisor process wait failed")
        exit_code = wintypes.DWORD()
        if wait_result == 258:
            exit_code.value = 125
        else:
            checked(kernel.GetExitCodeProcess(process.process, ctypes.byref(exit_code)))
        checked(kernel.TerminateJobObject(job, 125))
        deadline = time.monotonic() + 5
        while True:
            accounting = Accounting()
            checked(kernel.QueryInformationJobObject(job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None))
            if accounting.active == 0:
                return exit_code.value
            if time.monotonic() >= deadline:
                raise RuntimeError("CLI supervisor descendant cleanup did not settle")
            time.sleep(0.01)
    finally:
        # Also terminates the child if startup or a checked cleanup operation failed.
        kernel.CloseHandle(job)
        if process.thread:
            kernel.CloseHandle(process.thread)
        if process.process:
            kernel.CloseHandle(process.process)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Never print private arguments, account metadata or observations.
        sys.stderr.write("CLI owned process supervision failed. Request rejected.\n")
        sys.exit(125)
