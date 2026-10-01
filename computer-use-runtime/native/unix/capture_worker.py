"""Deadline-bound, capture-only child. Portal/session authority stays in the parent."""
import json
import ctypes
import os
from pathlib import Path
import select
import signal
import socket
import struct
import subprocess
import sys
import time
import uuid

MAX_JSON_BYTES = 32768
MAX_PIXEL_BYTES = 128 * 1024 * 1024
HEADER = struct.Struct("!II")
SETTLED_STOP = 20
SETTLEMENT_FAILED = 21


def _wait(stream, write, deadline, cancelled):
    while True:
        if cancelled(): raise RuntimeError("PipeWire capture cancelled")
        remaining = None if deadline is None else deadline - time.monotonic()
        if remaining is not None and remaining <= 0:
            raise RuntimeError("PipeWire capture deadline exceeded")
        ready = select.select([] if write else [stream], [stream] if write else [], [],
                              .025 if remaining is None else min(.025, remaining))
        if ready[1 if write else 0]: return


def _receive(stream, count, deadline, cancelled):
    parts = []
    while count:
        _wait(stream, False, deadline, cancelled)
        try: value = stream.recv(min(count, 65536))
        except BlockingIOError: continue
        if not value: raise RuntimeError("PipeWire capture child closed its channel")
        parts.append(value); count -= len(value)
    return b"".join(parts)


def receive_message(stream, deadline=None, cancelled=lambda: False):
    json_size, pixel_size = HEADER.unpack(_receive(stream, HEADER.size, deadline, cancelled))
    if not 0 < json_size <= MAX_JSON_BYTES or pixel_size > MAX_PIXEL_BYTES:
        raise RuntimeError("PipeWire capture channel size rejected")
    value = json.loads(_receive(stream, json_size, deadline, cancelled))
    if not isinstance(value, dict): raise RuntimeError("PipeWire capture envelope rejected")
    return value, _receive(stream, pixel_size, deadline, cancelled)


def send_message(stream, value, pixels=b"", deadline=None, cancelled=lambda: False):
    encoded = json.dumps(value, allow_nan=False, separators=(",", ":")).encode()
    if not 0 < len(encoded) <= MAX_JSON_BYTES or len(pixels) > MAX_PIXEL_BYTES:
        raise RuntimeError("PipeWire capture channel size rejected")
    for part in (HEADER.pack(len(encoded), len(pixels)), encoded, pixels):
        position = 0
        while position < len(part):
            _wait(stream, True, deadline, cancelled)
            try: sent = stream.send(memoryview(part)[position:position+65536])
            except BlockingIOError: continue
            if not sent: raise RuntimeError("PipeWire capture channel write failed")
            position += sent


class PipeWireCapture:
    """The parent never enters a blocking GStreamer state transition."""
    def __init__(self, fd, node, timeout_ms=2000, cancelled=lambda: False, worker_command=None):
        if sys.platform != "linux": raise RuntimeError("PipeWire capture child requires Linux")
        if not isinstance(timeout_ms, int) or not 0 < timeout_ms <= 120000:
            raise RuntimeError("PipeWire capture startup deadline rejected")
        self.closed = False; self.metadata = {}; self.last_image = None
        self.process = None; self.stream = None; self.cleanup_errors = []; self.cleanup_history = []
        self.terminal_fd = None; self.terminal = None; self.terminal_checked = False
        self.terminal_error = None
        self.owner = os.getpid(); self.terminal_token = uuid.uuid4().hex
        startup_deadline = time.monotonic()+timeout_ms/1000
        child = None; terminal_write = None
        try:
            parent, child = socket.socketpair()
            self.stream = parent
            parent.setblocking(False)
            terminal_read, terminal_write = os.pipe()
            self.terminal_fd = terminal_read
            os.set_blocking(terminal_read, False)
            file = str(Path(__file__).resolve())
            actor = worker_command or [sys.executable, file, "--pipeline"]
            self.process = subprocess.Popen([sys.executable, file, "--guard", str(child.fileno()), str(fd), str(node), json.dumps(actor),
                                             str(terminal_write), str(self.owner), self.terminal_token],
                                            pass_fds=(child.fileno(), fd, terminal_write), start_new_session=True,
                                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
            os.close(terminal_write); terminal_write = None
            child.close()
            value, pixels = self._request("initialize", {}, startup_deadline, cancelled)
            if pixels or value != {"ready": True}:
                raise RuntimeError("PipeWire capture startup response rejected")
        except BaseException as error:
            errors = []
            for cleanup in ([child.close] if child else []) + ([lambda: os.close(terminal_write)] if terminal_write is not None else []):
                try: cleanup()
                except Exception as caught: errors.append(str(caught))
            errors.extend(self._stop())
            if errors: raise RuntimeError(str(error)+"; capture cleanup failed: "+"; ".join(errors)) from error
            raise

    def _read_terminal(self):
        if self.terminal is not None: return []
        if self.process is None: return []  # Popen never acquired a child.
        if self.terminal_checked: return [self.terminal_error] if self.terminal_error else []
        self.terminal_checked = True
        try:
            raw = b""
            while True:
                part = os.read(self.terminal_fd, 4097-len(raw))
                if not part: break
                raw += part
                if len(raw) > 4096: raise RuntimeError("Capture guardian terminal size rejected")
            value = json.loads(raw)
            required = {"version", "guardian", "owner", "token", "descendantsSettled", "outcome", "actorExitCode"}
            if (not isinstance(value, dict) or set(value) != required or type(value["version"]) is not int or value["version"] != 1
                    or value["guardian"] != self.process.pid or value["owner"] != self.owner
                    or value["token"] != self.terminal_token or value["descendantsSettled"] is not True
                    or type(value["actorExitCode"]) is not int
                    or (value["outcome"], self.process.returncode) not in (("completed", 0), ("stopped", SETTLED_STOP))):
                raise RuntimeError("Capture guardian terminal identity/status rejected")
            self.terminal = value
            return []
        except Exception as error:
            self.terminal_error = "Capture guardian descendant settlement unverified: " + str(error)
            return [self.terminal_error]

    def _stop(self, graceful=False, acknowledge=False):
        errors = []
        self.closed = True; self.metadata = {}; self.last_image = None
        if self.stream:
            try: self.stream.close()
            except Exception as error: errors.append(str(error))
            else: self.stream = None
        if graceful and self.process and self.process.poll() is None:
            try: self.process.wait(timeout=1)
            except subprocess.TimeoutExpired: pass
            except Exception as error: errors.append(str(error))
        if self.process and self.process.poll() is None:
            # This exact child began a private session. GStreamer has no input
            # permission and cannot acquire a portal session of its own.
            try: os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError: pass
            except Exception as error: errors.append(str(error))
            try: self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                errors.append("Capture guardian did not prove descendant settlement")
                try: os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                except Exception as error: errors.append(str(error))
                try: self.process.wait(timeout=.5)
                except Exception as error: errors.append("Capture child settlement unverified: "+str(error))
            except Exception as error: errors.append(str(error))
        if self.process and self.process.poll() is not None and self.terminal is None:
            errors.extend(self._read_terminal())
        if self.terminal_fd is not None and (self.process is None or self.process.poll() is not None):
            try: os.close(self.terminal_fd)
            except Exception as error: errors.append("Capture terminal FD close failed: "+str(error))
            else: self.terminal_fd = None
        self.cleanup_history.extend(errors)
        if acknowledge: self.cleanup_errors = errors
        else: self.cleanup_errors.extend(errors)
        return list(self.cleanup_errors)

    def _request(self, operation, params, deadline, cancelled=lambda: False):
        if self.closed or self.process is None or self.stream is None:
            raise RuntimeError("PipeWire capture is closed")
        identifier = uuid.uuid4().hex
        try:
            send_message(self.stream, {"id": identifier, "operation": operation, "params": params}, deadline=deadline, cancelled=cancelled)
            response, pixels = receive_message(self.stream, deadline, cancelled)
            if response.get("id") != identifier or set(response) not in ({"id", "result"}, {"id", "error"}):
                raise RuntimeError("PipeWire capture response identity rejected")
            if "error" in response:
                if pixels or not isinstance(response["error"], str):
                    raise RuntimeError("PipeWire capture error envelope rejected")
                raise RuntimeError("PipeWire capture unavailable: "+response["error"])
            return response["result"], pixels
        except BaseException as error:
            errors = self._stop()
            if isinstance(error, (KeyboardInterrupt, SystemExit)): raise
            raise RuntimeError(str(error)+(('; capture cleanup failed: '+ '; '.join(errors)) if errors else '')) from error

    def image(self, timeout_ms=250, after=None, deadline=None, cancelled=lambda: False):
        from PIL import Image
        if not isinstance(timeout_ms, int) or not 0 <= timeout_ms <= 120000:
            raise RuntimeError("PipeWire frame deadline rejected")
        # 100 ms is the explicit bounded local-channel allowance. Initial
        # consent still caps this entire operation at its original deadline.
        end = time.monotonic() + timeout_ms/1000 + .1
        if deadline is not None: end = min(end, deadline)
        value, pixels = self._request("image", {"timeoutMs": timeout_ms, "after": after}, end, cancelled)
        try:
            if set(value) != {"width", "height", "mode", "metadata"} or value["mode"] != "RGB":
                raise RuntimeError("PipeWire frame envelope rejected")
            width, height = value["width"], value["height"]
            if type(width) is not int or type(height) is not int or not 0 < width <= 16384 or not 0 < height <= 16384 or len(pixels) != width*height*3:
                raise RuntimeError("PipeWire frame dimensions/bytes rejected")
            metadata = value["metadata"]
            allowed = {"pixelFrameCached", "pixelFrameSequence", "pixelReceivedAt", "pixelTimestampProvenance", "pixelSourcePtsNs", "pixelCapturedAt"}
            if not isinstance(metadata, dict) or set(metadata) - allowed or type(metadata.get("pixelFrameCached")) is not bool:
                raise RuntimeError("PipeWire frame metadata rejected")
            if type(metadata.get("pixelFrameSequence")) is not int or metadata["pixelFrameSequence"] < 1 or type(metadata.get("pixelReceivedAt")) is not int:
                raise RuntimeError("PipeWire frame sequence/time rejected")
            if metadata.get("pixelTimestampProvenance") != "GStreamer source PTS mapped through pipeline clock":
                raise RuntimeError("PipeWire frame timestamp provenance rejected")
            if "pixelCapturedAt" in metadata and (type(metadata["pixelCapturedAt"]) is not int or not 0 <= metadata["pixelCapturedAt"] <= metadata["pixelReceivedAt"]):
                raise RuntimeError("PipeWire frame capture time rejected")
            if "pixelSourcePtsNs" in metadata and (not isinstance(metadata["pixelSourcePtsNs"], str) or not metadata["pixelSourcePtsNs"].isdigit()):
                raise RuntimeError("PipeWire frame source PTS rejected")
            image = Image.frombytes("RGB", (width, height), pixels)
            if cancelled() or time.monotonic() >= end: raise RuntimeError("PipeWire frame deadline exceeded")
            self.metadata = metadata; self.last_image = image
            return image
        except BaseException as error:
            errors = self._stop()
            if errors: raise RuntimeError(str(error)+"; capture cleanup failed: "+"; ".join(errors)) from error
            raise

    def poll(self):
        if self.closed or self.process is None or self.process.poll() is not None:
            errors = self._stop()
            raise RuntimeError("PipeWire capture child is unavailable"+('; '+ '; '.join(errors) if errors else ''))
        value, pixels = self._request("poll", {}, time.monotonic()+.25)
        if value != {"active": True} or pixels:
            errors = self._stop()
            raise RuntimeError("Capture poll response rejected"+('; '+ '; '.join(errors) if errors else ''))

    def close(self):
        error = None; requested = not self.closed
        if not self.closed:
            try:
                value, pixels = self._request("close", {}, time.monotonic()+.25)
                if value != {"closed": True} or pixels: raise RuntimeError("Capture close acknowledgment rejected")
            except Exception as caught: error = caught
        errors = self._stop(graceful=error is None, acknowledge=True)
        if requested and error is None and self.terminal and self.terminal['outcome'] != 'completed':
            error = RuntimeError('Capture child cleanup did not complete successfully')
        if error or errors:
            raise RuntimeError("PipeWire capture close failed: "+str(error or '')+"; "+"; ".join(errors)) from error


def pipeline_main(arguments):
    stream = socket.socket(fileno=int(arguments[0]))
    stream.setblocking(False)
    fd, node = int(arguments[1]), int(arguments[2])
    capture = None
    try:
        while True:
            request, payload = receive_message(stream)
            if payload or set(request) != {"id", "operation", "params"} or not isinstance(request["id"], str) or not isinstance(request["params"], dict):
                raise RuntimeError("Capture command envelope rejected")
            operation, params = request["operation"], request["params"]
            pixels = b""
            try:
                if operation == "initialize" and capture is None and params == {}:
                    from portal import _PipeWirePipeline
                    capture = _PipeWirePipeline(fd, node)
                    result = {"ready": True}
                elif operation == "image" and capture and set(params) == {"timeoutMs", "after"}:
                    if type(params["timeoutMs"]) is not int or not 0 <= params["timeoutMs"] <= 120000:
                        raise RuntimeError("Capture frame timeout rejected")
                    if params["after"] is not None and type(params["after"]) is not int:
                        raise RuntimeError("Capture frame timestamp rejected")
                    image = capture.image(params["timeoutMs"], params["after"])
                    pixels = image.tobytes()
                    result = {"width": image.width, "height": image.height, "mode": image.mode, "metadata": capture.metadata}
                elif operation == "poll" and capture and params == {}:
                    capture.poll(); result = {"active": True}
                elif operation == "close" and params == {}:
                    if capture: capture.close(); capture = None
                    send_message(stream, {"id": request["id"], "result": {"closed": True}})
                    return
                else: raise RuntimeError("Capture command rejected")
                send_message(stream, {"id": request["id"], "result": result}, pixels)
            except Exception as error:
                send_message(stream, {"id": request["id"], "error": str(error)[:2048]})
                return
    finally:
        errors = []
        for cleanup in [*( [capture.close] if capture else []), lambda: os.close(fd), stream.close]:
            try: cleanup()
            except Exception as error: errors.append(error)
        if errors:
            aggregate = RuntimeError("Capture child cleanup failed: " + "; ".join(str(error) for error in errors))
            aggregate.cleanup_errors = errors
            raise aggregate from errors[0]


def _descendants():
    rows = {}
    for name in os.listdir('/proc'):
        if not name.isdecimal(): continue
        try:
            fields = Path('/proc', name, 'stat').read_text().rsplit(')', 1)[1].split()
            rows[int(name)] = (int(fields[1]), fields[0], fields[19])
        except (FileNotFoundError, ProcessLookupError): continue
    owned = {os.getpid()}
    while True:
        added = {pid for pid, row in rows.items() if row[0] in owned} - owned
        if not added: break
        owned.update(added)
    return {pid: rows[pid] for pid in owned if pid != os.getpid()}


def _drain_capture_children():
    deadline = time.monotonic()+.6
    hard_at = time.monotonic()+.2
    while True:
        while True:
            try:
                if not os.waitpid(-1, os.WNOHANG)[0]: break
            except ChildProcessError: break
        remaining = _descendants()
        if not remaining: return
        if time.monotonic() >= deadline: raise RuntimeError('Capture descendants did not settle')
        for pid, (_, state, identity) in remaining.items():
            if state == 'Z': continue
            try: descriptor = os.pidfd_open(pid)
            except ProcessLookupError: continue
            try:
                try: current = Path('/proc', str(pid), 'stat').read_text().rsplit(')', 1)[1].split()
                except FileNotFoundError: continue
                if current[19] != identity: continue
                try: signal.pidfd_send_signal(descriptor, signal.SIGKILL if time.monotonic() >= hard_at else signal.SIGTERM)
                except ProcessLookupError: pass
            finally: os.close(descriptor)
        time.sleep(.01)


def actor_main(arguments):
    """Arm an uncatchable guardian-death signal before loading GStreamer."""
    guardian = int(arguments[0]); command = json.loads(arguments[1])
    if not isinstance(command,list) or not command or not all(isinstance(value,str) and value for value in command):
        raise RuntimeError('Capture actor bootstrap command rejected')
    if not Path(command[0]).is_absolute(): raise RuntimeError('Capture actor executable must be absolute')
    library = ctypes.CDLL(None,use_errno=True)
    if library.prctl(1,signal.SIGKILL,0,0,0) != 0:
        raise RuntimeError('Capture guardian death guard unavailable')
    if os.getppid() != guardian:
        raise RuntimeError('Capture guardian changed before actor registration')
    os.execv(command[0],command)


def guardian_main(arguments):
    socket_fd, capture_fd, node = map(int, arguments[:3])
    actor = json.loads(arguments[3])
    terminal_fd, owner = map(int, arguments[4:6])
    token = arguments[6]
    if not isinstance(actor, list) or not actor or not all(isinstance(value,str) and value for value in actor):
        raise RuntimeError('Capture actor command rejected')
    if sys.platform != 'linux' or not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):
        raise RuntimeError('Linux capture descendant ownership is unavailable')
    library = ctypes.CDLL(None, use_errno=True)
    enabled = ctypes.c_int()
    if library.prctl(36,1,0,0,0) != 0 or library.prctl(37,ctypes.byref(enabled),0,0,0) != 0 or enabled.value != 1:
        raise RuntimeError('Capture subreaper ownership was not confirmed')
    if owner != os.getppid(): raise RuntimeError('Capture owner changed before registration')
    owner_fd = os.pidfd_open(owner)
    stopping = False
    def stop(_signal,_frame):
        nonlocal stopping
        stopping = True
    signal.signal(signal.SIGTERM,stop)
    process = None
    failed = False; errors = []
    try:
        # Opening a pidfd and checking again closes the parent-death race.
        if owner != os.getppid() or select.select([owner_fd], [], [], 0)[0]:
            raise RuntimeError('Capture owner died during registration')
        command = [*actor,str(socket_fd),str(capture_fd),str(node)]
        process = subprocess.Popen([sys.executable,str(Path(__file__).resolve()),'--actor',str(os.getpid()),json.dumps(command)],
                                   pass_fds=(socket_fd,capture_fd),start_new_session=True)
        os.close(socket_fd); os.close(capture_fd)
        socket_fd = capture_fd = None
        while process.poll() is None and not stopping:
            if select.select([owner_fd], [], [], .01)[0]: stopping = True
        failed = stopping or process.returncode != 0 or bool(_descendants())
    except BaseException as error:
        errors.append(error)
    finally:
        for descriptor in (socket_fd, capture_fd, owner_fd):
            if descriptor is not None:
                try: os.close(descriptor)
                except Exception as error: errors.append(error)
        try: _drain_capture_children()
        except Exception as error: errors.append(error)
        if process:
            try: process.wait(timeout=.1)
            except Exception as error: errors.append(error)
    # The actor does not inherit this private pipe. Only the guardian can
    # acknowledge that adopted descendants were drained and reaped.
    result = SETTLEMENT_FAILED
    try:
        if not errors and process is not None:
            terminal = {"version":1,"guardian":os.getpid(),"owner":owner,"token":token,
                        "descendantsSettled":True,"outcome":"stopped" if failed else "completed",
                        "actorExitCode":process.returncode}
            os.write(terminal_fd, json.dumps(terminal, separators=(",", ":")).encode())
            result = SETTLED_STOP if failed else 0
    except OSError:
        result = SETTLEMENT_FAILED
    finally:
        os.close(terminal_fd)
    return result


if __name__ == "__main__":
    if sys.argv[1] == '--guard': raise SystemExit(guardian_main(sys.argv[2:]))
    if sys.argv[1] == '--actor': actor_main(sys.argv[2:])
    elif sys.argv[1] == '--pipeline': pipeline_main(sys.argv[2:])
    else: raise RuntimeError('Capture worker mode rejected')
