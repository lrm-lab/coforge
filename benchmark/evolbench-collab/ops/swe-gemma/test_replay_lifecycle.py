"""Control SIGTERM between child creation and registration through the CLI."""
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class ReplayLifecycleTest(unittest.TestCase):
    def test_stop_during_launch_leaves_no_role_child(self):
        class Status(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                body = b'{"limit":20}'
                self.send_response(200); self.send_header('Content-Length', str(len(body)))
                self.end_headers(); self.wfile.write(body)
        server = ThreadingHTTPServer(('127.0.0.1', 0), Status)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        child_pid = None
        try:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root/'source'
                for index in range(20):
                    case = source/f'm{index:02d}'; (case/'sessions').mkdir(parents=True)
                    (case/'attempts.jsonl').write_text('{}\n')
                    (case/'verdicts.jsonl').write_text(json.dumps({'session_id':f's-{index}','episode_id':f'e-{index}'})+'\n')
                home = root/'home'; (home/'.pi/agent').mkdir(parents=True)
                (home/'.pi/agent/models.json').write_text(json.dumps({'providers':{'lenovo-gemma':{'apiKey':'test-key'}}}))
                ov = root/'ov'; (ov/'benchmark/causal_memory').mkdir(parents=True)
                for name in ['aig0045_verdict_smoke.py','lenovo_gemma_provider.py','aig0045_gemma_roles.py']:
                    (ov/'benchmark/causal_memory'/name).write_text('# fixture\n')
                subprocess.run(['git','init','-q',str(ov)],check=True)
                subprocess.run(['git','-C',str(ov),'-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-q','--allow-empty','-m','fixture'],check=True)
                fake = root/'role-python'
                fake.write_text(f'#!{sys.executable}\nimport time\ntime.sleep(60)\n'); fake.chmod(0o755)
                pid_path = root/'launched.pid'
                harness = root/'harness.py'
                harness.write_text('''import os, signal, subprocess, sys, threading
import replay_four_roles
original_popen = subprocess.Popen
original_signal = signal.signal
stopping = threading.Event()
def install(sig, handler):
    def wrapped(signum, frame):
        stopping.set()
        return handler(signum, frame)
    return original_signal(sig, wrapped)
def gated(command, *args, **kwargs):
    child = original_popen(command, *args, **kwargs)
    if command[0] == sys.argv[-1]:
        open(os.environ['TEST_PID_PATH'], 'w').write(str(child.pid))
        os.kill(os.getpid(), signal.SIGTERM)
        if not stopping.wait(5): raise RuntimeError('stop handler did not start')
    return child
signal.signal = install
subprocess.Popen = gated
replay_four_roles.main()
''')
                command = [sys.executable,str(harness),'--source',str(source),'--root',str(root/'run'),'--openviking',str(ov),'--pool-url',f'http://127.0.0.1:{server.server_port}','--python',str(fake)]
                environment = {**os.environ,'HOME':str(home),'TEST_PID_PATH':str(pid_path),'PYTHONPATH':str(Path(__file__).parent)}
                try:
                    result = subprocess.run(command, env=environment, capture_output=True, timeout=15)
                    child_pid = int(pid_path.read_text())
                    self.assertEqual(result.returncode, 143, result.stderr.decode())
                    self.assertFalse(Path(f'/proc/{child_pid}').exists(), 'owned role child survived stop')
                finally:
                    if pid_path.exists():
                        child_pid = int(pid_path.read_text())
                        process = Path(f'/proc/{child_pid}/cmdline')
                        if process.exists() and str(fake).encode() in process.read_bytes():
                            os.kill(child_pid, signal.SIGKILL)
        finally:
            server.shutdown(); server.server_close()
