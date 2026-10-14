import concurrent.futures
import json
import tempfile
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from llm_pool import LlmPool, PoolServer


class PoolTests(unittest.TestCase):
    def test_shared_cap_retry_hidden_and_audit(self):
        lock = threading.Lock()
        active = peak = calls = 0
        entered = threading.Event()
        release = threading.Event()
        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                nonlocal active, peak, calls
                self.rfile.read(int(self.headers['Content-Length']))
                with lock:
                    active += 1
                    peak = max(peak, active)
                    calls += 1
                    first = calls == 1
                    if active == 2: entered.set()
                if not first: release.wait(5)
                with lock: active -= 1
                body = json.dumps({'error': 'temporary'} if first else {'choices': [], 'usage': {'prompt_tokens': 3, 'completion_tokens': 2}}).encode()
                self.send_response(429 if first else 200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        with tempfile.TemporaryDirectory() as temporary:
            endpoint = {'name': 'test', 'url': f'http://127.0.0.1:{upstream.server_port}/chat/completions', 'key': 'unit-test-secret', 'capacity': 2}
            pool = LlmPool([{**endpoint, 'name': 'first', 'capacity': 1}, {**endpoint, 'name': 'second', 'capacity': 1}], Path(temporary), sleep=lambda _: None, proxy='')
            server = PoolServer(('127.0.0.1', 0), pool)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            def request(client):
                req = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/llm/v1/chat/completions', data=b'{"model":"gemma-4-31B-it"}', headers={'Authorization': 'Bearer unit-test-secret', 'X-Coforge-LLM-Client': client})
                return json.load(urllib.request.urlopen(req, timeout=10))
            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
                    futures = [executor.submit(request, client) for client in ['task', 'memory', 'builder', 'reader']]
                    self.assertTrue(entered.wait(5))
                    self.assertEqual(pool.snapshot()['active'], 2)
                    release.set()
                    self.assertTrue(all(f.result()['usage']['completion_tokens'] == 2 for f in futures))
                self.assertEqual(peak, 2)
                self.assertEqual(calls, 5)
                self.assertEqual(pool.snapshot()['active'], 0)
                audit = (Path(temporary)/'requests.jsonl').read_text()
                self.assertNotIn('unit-test-secret', audit)
                events = [json.loads(line) for line in audit.splitlines()]
                self.assertEqual(sum(e['event'] == 'retry' for e in events), 1)
                self.assertEqual({e['client'] for e in events}, {'task', 'memory', 'builder', 'reader'})
            finally:
                release.set()
                server.shutdown(); server.server_close()
                upstream.shutdown(); upstream.server_close()

    def test_audit_failure_releases_slot(self):
        with tempfile.TemporaryDirectory() as temporary:
            pool = LlmPool([{'name': 'test', 'capacity': 1, 'url': 'http://127.0.0.1:1', 'key': 'test-key'}], Path(temporary))
            def failed_record(*args, **kwargs): raise OSError('disk full')
            pool.record = failed_record
            with self.assertRaises(OSError): pool.complete(b'{}', 'task')
            self.assertEqual(pool.snapshot()['active'], 0)

    def test_trickling_response_obeys_total_deadline(self):
        class Slow(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                import time
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                try:
                    for _ in range(20):
                        self.wfile.write(b'x'); self.wfile.flush(); time.sleep(.03)
                except (BrokenPipeError, ConnectionError): pass
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Slow)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        try:
            import time
            with tempfile.TemporaryDirectory() as temporary:
                pool = LlmPool([{'name':'slow', 'url':f'http://127.0.0.1:{upstream.server_port}', 'key':'test-key', 'capacity':1}], Path(temporary), proxy='', budget_seconds=.1)
                started = time.monotonic()
                self.assertEqual(pool.complete(b'{}', 'task')[0], 424)
                self.assertLess(time.monotonic()-started, .4)
                self.assertEqual(pool.snapshot()['active'], 0)
        finally: upstream.shutdown(); upstream.server_close()
