"""Pinned OSWorld/WindowsAgentArena computer_13 actions through one Runtime.

CoordinatorProcessBridge starts the repository's private stdio coordinator using
trusted local configuration. No benchmark VM endpoint or evaluator access is
assumed. The next predict call acknowledges the runner roundtrip only. Runtime
completion still needs independent measurement of public observation bytes.
"""
import base64
import collections
import json
import math
import pathlib
import queue
import subprocess
import threading
import time
import uuid


class CoordinatorProcessBridge:
    """A private child process, not an HTTP task submitted to another executor."""
    def __init__(self, package_root, configuration_path, node="node", timeout=15, mode="auto"):
        root = pathlib.Path(package_root).resolve(strict=True)
        configuration = pathlib.Path(configuration_path).resolve(strict=True)
        source_coordinator = root / "evaluation" / "benchmark-coordinator.ts"
        compiled_coordinator = root / "dist" / "evaluation" / "benchmark-coordinator.js"
        if mode not in ("auto", "source", "compiled"):
            raise ValueError("Unknown coordinator library mode")
        compiled = mode == "compiled" or (mode == "auto" and compiled_coordinator.is_file() and configuration.suffix != ".ts")
        coordinator = compiled_coordinator if compiled else source_coordinator
        if not coordinator.is_file() or not (root / "package.json").is_file():
            raise ValueError("Expected the computer-use-runtime package root")
        if compiled and configuration.suffix == ".ts":
            raise ValueError("Compiled coordinator requires a JavaScript configuration module")
        if configuration.suffix not in (".mjs", ".js", ".ts"):
            raise ValueError("Expected a trusted local coordinator configuration module")
        if pathlib.Path(node).name.lower() not in ("node", "node.exe"):
            raise ValueError("Only the configured Node runtime can start the coordinator")
        if not isinstance(timeout, (int, float)) or not 1 <= timeout <= 120:
            raise ValueError("Private coordinator timeout must be 1 to 120 seconds")
        self.timeout = timeout
        self.closed = False
        self.responses = queue.Queue(maxsize=8)
        self.writes = queue.Queue(maxsize=1)
        self.errors = collections.deque(maxlen=32)
        self.lock = threading.Lock()
        self.process = subprocess.Popen(
            [node, *([] if compiled else ["--import", "tsx"]), str(coordinator), "--config", str(configuration)],
            cwd=str(root), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, shell=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        threading.Thread(target=self._responses, daemon=True).start()
        threading.Thread(target=self._stderr, daemon=True).start()
        threading.Thread(target=self._writer, daemon=True).start()

    def _writer(self):
        while True:
            item = self.writes.get()
            if item is None:
                return
            raw, completed, errors = item
            try:
                self.process.stdin.write(raw)
                self.process.stdin.flush()
            except (OSError, ValueError) as error:
                errors.append(error)
            finally:
                completed.set()

    def _interrupt(self):
        self.closed = True
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=3)
        self.process.stdin.close()

    def _responses(self):
        try:
            while True:
                line = self.process.stdout.readline(9 * 1024 * 1024 + 1)
                if not line:
                    raise RuntimeError("Private coordinator closed before its response")
                if len(line) > 9 * 1024 * 1024 or not line.endswith(b"\n"):
                    raise RuntimeError("Private coordinator response exceeds byte limit")
                self.responses.put(json.loads(line), timeout=1)
        except Exception as error:
            try:
                self.responses.put(error, timeout=1)
            except queue.Full:
                self.process.terminate()

    def _stderr(self):
        try:
            while True:
                chunk = self.process.stderr.read(1024)
                if not chunk:
                    return
                self.errors.append(chunk.decode("utf-8", errors="replace"))
        except (OSError, ValueError):
            return

    def _request(self, method, **parameters):
        with self.lock:
            if self.closed or self.process.poll() is not None:
                raise RuntimeError("Private coordinator is not running")
            request_id = str(uuid.uuid4())
            raw = json.dumps({"id": request_id, "method": method, **parameters},
                             separators=(",", ":")).encode() + b"\n"
            if len(raw) > 9 * 1024 * 1024:
                raise ValueError("Private coordinator request exceeds byte limit")
            try:
                deadline = time.monotonic() + self.timeout
                completed, errors = threading.Event(), []
                self.writes.put((raw, completed, errors), timeout=self.timeout)
                if not completed.wait(max(0, deadline - time.monotonic())):
                    raise queue.Empty("Coordinator pipe write deadline expired")
                if errors:
                    raise OSError("Coordinator pipe write failed") from errors[0]
                response = self.responses.get(timeout=max(0, deadline - time.monotonic()))
                if isinstance(response, Exception):
                    self._interrupt()
                    raise response
                if not isinstance(response, dict) or response.get("id") != request_id:
                    self._interrupt()
                    raise RuntimeError("Private coordinator response identity mismatch")
                if "error" in response:
                    raise RuntimeError(response["error"])
                if "result" not in response:
                    self._interrupt()
                    raise RuntimeError("Private coordinator response has no result")
                return response["result"]
            except (OSError, queue.Empty) as error:
                self._interrupt()
                raise RuntimeError("Coordinator transport interrupted. Do not replay outstanding input.") from error

    def reset(self, host, session):
        return self._request("reset", host=host, session=session)

    def next_action(self, instruction, observation, pending, host, session):
        action = self._request("next_action", instruction=instruction,
                               observation=observation, pending=pending, host=host, session=session)
        try:
            self.validate_action(action, host, session)
        except ValueError:
            self._interrupt()
            raise
        return action

    @staticmethod
    def validate_action(action, host, session):
        if not isinstance(action, dict) or not isinstance(action.get("runId"), str) or not action["runId"]:
            raise ValueError("Coordinator result must bind a runtime run")
        if "id" in action:
            deadline = action.get("deadline")
            if (not isinstance(action["id"], str) or not action["id"] or
                    action.get("host") != host or action.get("session") != session or
                    isinstance(deadline, bool) or not isinstance(deadline, (int, float)) or
                    not math.isfinite(deadline) or deadline <= time.time() * 1000 or
                    action.get("operation") not in ("click", "type", "key", "scroll", "drag", "wait")):
                raise ValueError("Coordinator input result changed its host/session/action/deadline binding")
        elif action.get("operation") == "done":
            if action.get("phase") != "verified":
                raise ValueError("DONE requires independently verified runtime completion")
        elif action.get("operation") == "wait":
            if action.get("phase") != "observation_required":
                raise ValueError("Unbound WAIT must request a fresh observation")
        elif action.get("operation") != "fail":
            raise ValueError("Unbound coordinator input operation is forbidden")

    def close(self):
        if not self.closed and self.process.poll() is None:
            try:
                self._request("close")
            finally:
                self.closed = True
                self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        for stream in (self.process.stdout, self.process.stderr):
            stream.close()
        try:
            self.writes.put_nowait(None)
        except queue.Full:
            pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def _number(value, field):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError("Invalid benchmark coordinate " + field)
    return value


def _chord(value):
    if not isinstance(value, str) or not value or len(value) > 80:
        raise ValueError("Runtime key must be a literal key chord")
    aliases = {"Control": "ctrl", "Shift": "shift", "Alt": "alt", "Meta": "win",
               "Enter": "enter", "Tab": "tab", "Escape": "esc", "Space": "space",
               "ArrowLeft": "left", "ArrowRight": "right", "ArrowUp": "up", "ArrowDown": "down",
               "Home": "home", "End": "end", "PageUp": "pageup", "PageDown": "pagedown",
               "Backspace": "backspace", "Delete": "delete"}
    result = []
    for token in value.split("+"):
        key = aliases.get(token)
        if key is None and (len(token) == 1 and token.isascii() and token.isalnum()):
            key = token.lower()
        if key is None and token.startswith("F") and token[1:].isdigit() and 1 <= int(token[1:]) <= 12:
            key = token.lower()
        if key is None or key in result:
            raise ValueError("Unsupported runtime key chord")
        result.append(key)
    return result


class BenchmarkAgent:
    def __init__(self, bridge, host, session, track="structured"):
        if track not in ("structured", "pixel"):
            raise ValueError("Unknown observation track")
        self.bridge, self.host, self.session, self.track = bridge, host, session, track
        self.pending = None

    def reset(self, _logger=None, **_kwargs):
        self.bridge.reset(self.host, self.session)
        self.pending = None

    def predict(self, instruction, obs):
        screenshot = obs["screenshot"]
        if not isinstance(screenshot, bytes) or len(screenshot) > 6 * 1024 * 1024:
            raise ValueError("Benchmark screenshot must contain bounded bytes")
        allowed = {"screenshot": base64.b64encode(screenshot).decode()}
        if self.track == "structured" and "accessibility_tree" in obs:
            tree = obs["accessibility_tree"]
            if not isinstance(tree, str) or len(tree.encode()) > 262144:
                raise ValueError("Accessibility tree must be bounded public text")
            allowed["accessibility_tree"] = tree
        # task_config, reward, done, info and evaluator state never cross this boundary.
        action = self.bridge.next_action(instruction, allowed, self.pending, self.host, self.session)
        if not isinstance(action, dict):
            raise ValueError("Invalid coordinator action")
        if "id" in action and (not isinstance(action["id"], str) or not action["id"]):
            raise ValueError("Invalid coordinator action identity")
        try:
            actions = self.map_actions(action)
        except ValueError:
            if hasattr(self.bridge, "close"):
                self.bridge.close()
            raise
        self.pending = action.get("id")
        if action.get("phase") == "observation_required":
            return "Coordinator requests a fresh observation while planning. No input action was returned.", actions
        return "Runtime returned a guarded action or terminal status. Input effect requires independent verification.", actions

    @staticmethod
    def map_actions(action):
        op, args = action.get("operation"), action.get("args", {})
        if not isinstance(args, dict):
            raise ValueError("Runtime action arguments must be a dictionary")
        if op == "click":
            button = args.get("button", "left")
            if button not in ("left", "right", "middle"):
                raise ValueError("Invalid benchmark mouse button")
            return [{"action_type": "CLICK", "x": _number(args.get("x"), "x"),
                     "y": _number(args.get("y"), "y"), "button": button}]
        if op == "type":
            text = args.get("text")
            if not isinstance(text, str) or len(text.encode()) > 8192 or any(ord(c) < 32 and c not in "\n\t\r" for c in text):
                raise ValueError("Runtime typing must be bounded literal text")
            return [{"action_type": "TYPING", "text": text}]
        if op == "scroll":
            amount = args.get("amount")
            if isinstance(amount, bool) or not isinstance(amount, int) or not amount or abs(amount) > 1200:
                raise ValueError("Runtime scroll needs signed amount within 1200")
            clicks = math.ceil(abs(amount) / 120) * (1 if amount > 0 else -1)
            return [{"action_type": "SCROLL", "dx": 0, "dy": clicks}]
        if op == "key":
            chord = _chord(args.get("key"))
            return [{"action_type": "HOTKEY", "keys": chord}] if len(chord) > 1 else [{"action_type": "PRESS", "key": chord[0]}]
        if op == "drag":
            return [{"action_type": "MOVE_TO", "x": _number(args.get("x"), "x"), "y": _number(args.get("y"), "y")},
                    {"action_type": "DRAG_TO", "x": _number(args.get("dx"), "dx"), "y": _number(args.get("dy"), "dy")}]
        if op in ("wait", "done", "fail"):
            return [op.upper()]
        raise ValueError("Unsupported benchmark operation: " + str(op))

    @staticmethod
    def map_action(action):
        actions = BenchmarkAgent.map_actions(action)
        if len(actions) != 1:
            raise ValueError("Drag requires map_actions so the start move is not lost")
        return actions[0]
