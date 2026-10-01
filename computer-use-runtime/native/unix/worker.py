"""Line-delimited JSON on private stdin/stdout. Parent closure releases input."""
import json
import queue
import signal
import sys
import threading
from common import Bridge, PreflightRejected


def read_requests(stream, requests, cancellation):
    """Only stdin parsing runs off-thread. Desktop work stays on the main thread."""
    try:
        for line in stream:
            try:
                if len(line) > 2_000_000: raise ValueError("Request too large")
                request = json.loads(line)
                if not isinstance(request, dict): raise ValueError("Request must be an object")
                sequence = cancellation["sequence"]
                if request.get("method") in ("cancel_consent", "stop", "takeover"):
                    cancellation["sequence"] += 1
                requests.put((request, sequence, None))
            except Exception as e:
                requests.put(({}, cancellation["sequence"], str(e)))
    finally:
        cancellation["closed"] = True
        requests.put(None)


def main():
    bridge = None
    error = None
    try:
        if sys.platform == "darwin":
            from macos import MacDesktop
            backend = MacDesktop()
        elif sys.platform == "linux":
            from linux import LinuxDesktop
            backend = LinuxDesktop()
        else:
            raise RuntimeError("This worker requires macOS or Linux")
        bridge = Bridge(backend)
    except Exception as e:
        error = str(e) + ". Run npm run setup:desktop and npm run doctor:desktop on this computer."
    def stop(_sig, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    requests = queue.Queue()
    cancellation = {"sequence": 0, "closed": False}
    threading.Thread(target=read_requests, args=(sys.stdin, requests, cancellation), daemon=True).start()
    try:
        while True:
            item = requests.get()
            if item is None: break
            request, sequence, parse_error = item
            try:
                if parse_error: raise ValueError(parse_error)
                if error:
                    raise RuntimeError(error)
                bridge.consent_cancelled = lambda: cancellation["closed"] or cancellation["sequence"] > sequence
                bridge.input_cancelled = bridge.consent_cancelled
                result = bridge.call(request["method"], request.get("params", {}))
                response = {"id": request["id"], "result": result}
            except PreflightRejected as e:
                response = {"id": request.get("id"), "result": e.receipt}
            except Exception as e:
                response = {"id": request.get("id"), "error": str(e)}
            print(json.dumps(response, ensure_ascii=True), flush=True)
    finally:
        if bridge:
            bridge.close()


if __name__ == "__main__":
    main()
