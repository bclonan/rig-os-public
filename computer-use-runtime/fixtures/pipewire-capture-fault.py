"""Capture protocol double in a real disposable process, without GStreamer/input."""
import json
import os
from pathlib import Path
import signal
import socket
import struct
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native/unix"))
from capture_worker import MAX_JSON_BYTES, PipeWireCapture, receive_message, send_message

mode, pid_path = sys.argv[1:3]
if mode == 'owner-death':
    # The coordinator exits only after its actor has entered the hung frame.
    capture = PipeWireCapture(int(sys.argv[3]),33,timeout_ms=2000,
        worker_command=[sys.executable,__file__,'hang-frame',pid_path])
    send_message(capture.stream,{'id':'owner-death','operation':'image','params':{'timeoutMs':0,'after':None}})
    until = time.monotonic()+2
    while not Path(pid_path).with_suffix('.frame').exists():
        if time.monotonic() >= until: raise RuntimeError('Owned actor did not enter frame fault')
        time.sleep(.01)
    os._exit(0)
stream = socket.socket(fileno=int(sys.argv[3])); stream.setblocking(False)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
pid = Path(pid_path)
temporary = pid.with_suffix('.pending')
owner = int(Path('/proc',str(os.getppid()),'stat').read_text().rsplit(')',1)[1].split()[1])
temporary.write_text(json.dumps({"pid": os.getpid(), "parent": os.getppid(), "owner": owner})); temporary.replace(pid)
sequence = 0
def hang():
    while True: time.sleep(.1)
try:
    while True:
        request, _ = receive_message(stream)
        operation = request['operation']
        if operation == 'initialize':
            if mode == 'double-fork-exit':
                first = os.fork()
                if first == 0:
                    os.setsid()
                    second = os.fork()
                    if second != 0: os._exit(0)
                    descendant = pid.with_suffix('.descendant')
                    pending = descendant.with_suffix('.pending')
                    pending.write_text(str(os.getpid())); pending.replace(descendant)
                    hang()
                os._exit(0)
            if mode == 'hang-start':
                pid.with_suffix('.started').write_text(str(time.monotonic())); hang()
            if mode == 'oversize':
                stream.sendall(struct.pack('!II', MAX_JSON_BYTES + 1, 0)); hang()
            send_message(stream, {'id': 'wrong' if mode == 'wrong-id' else request['id'], 'result': {'ready': True}})
        elif operation == 'image':
            if mode == 'hang-frame':
                pid.with_suffix('.frame').write_text(str(time.monotonic())); hang()
            sequence += 1
            pixels = bytes([255, 0, 0])*4
            if mode == 'bad-pixels': pixels = pixels[:-1]
            metadata = {'pixelFrameCached': mode == 'cached', 'pixelFrameSequence': sequence,
                        'pixelReceivedAt': 130, 'pixelCapturedAt': 123,
                        'pixelTimestampProvenance': 'GStreamer source PTS mapped through pipeline clock', 'pixelSourcePtsNs': '123000000'}
            if mode == 'bad-metadata': metadata['pixelFrameCached'] = 'false'
            send_message(stream, {'id': request['id'], 'result': {'width':2, 'height':2, 'mode':'RGB', 'metadata':metadata}}, pixels)
        elif operation == 'poll':
            if mode == 'kill-guardian':
                os.kill(os.getppid(),signal.SIGKILL); hang()
            send_message(stream, {'id':request['id'], 'result':{'active':True}})
        elif operation == 'close':
            if mode == 'hang-close': hang()
            send_message(stream, {'id':request['id'], 'result':{'closed':True}})
            if mode == 'close-finally-fail': raise RuntimeError('Capture actor final cleanup fault')
            break
finally: stream.close()
