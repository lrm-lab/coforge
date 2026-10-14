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

    def test_longer_backoff_releases_capacity_and_keeps_retry_budget(self):
        class Retry(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                self.send_response(503); self.send_header('Content-Length', '0')
                self.end_headers()
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Retry)
        threading.Thread(target=upstream.serve_forever, daemon=True).start()
        try:
            with tempfile.TemporaryDirectory() as temporary:
                delays = []
                now = [100.0]
                def sleep(delay):
                    self.assertEqual(pool.snapshot()['active'], 0)
                    delays.append(delay)
                    now[0] += delay
                pool = LlmPool([{'name':'test', 'url':f'http://127.0.0.1:{upstream.server_port}', 'key':'test-key', 'capacity':1}], Path(temporary), proxy='', sleep=sleep, clock=lambda: now[0])
                self.assertEqual(pool.snapshot()['retry_policy']['budget_seconds'], 900)
                self.assertEqual(pool.complete(b'{}', 'memory')[0], 424)
                self.assertEqual(pool.snapshot()['http_attempts'], 7)
                self.assertEqual(len(delays), 6)
                for actual, minimum in zip(delays, [15,30,60,120,120,120]):
                    self.assertGreaterEqual(actual, minimum)
                    self.assertLessEqual(actual, min(120, minimum+5))
        finally: upstream.shutdown(); upstream.server_close()


class HealthRoutingTests(unittest.TestCase):
    def test_circuit_avoids_failed_endpoint_and_probes_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            now=[100.0]
            endpoints=[{"name":name,"capacity":2,"url":"http://unused","key":"test"}
                       for name in ["bad","good"]]
            pool=LlmPool(endpoints,directory,clock=lambda:now[0])
            for _ in range(2):
                acquired=pool.acquire(110)
                if acquired["name"]!="bad":
                    pool.release(acquired,status=200,elapsed_ms=5)
                    acquired=pool.acquire(110)
                pool.release(acquired,status=503,elapsed_ms=50,retryable=True)
            self.assertEqual(pool.snapshot()["endpoints"]["bad"]["circuit"],"open")
            acquired=pool.acquire(110)
            self.assertEqual(acquired["name"],"good")
            pool.release(acquired,status=200,elapsed_ms=5)
            now[0]+=61
            probe=pool.acquire(180)
            self.assertEqual(probe["name"],"bad")
            other=pool.acquire(180)
            self.assertEqual(other["name"],"good")
            pool.release(other,status=200,elapsed_ms=5)
            pool.release(probe,status=200,elapsed_ms=4)
            self.assertEqual(pool.snapshot()["endpoints"]["bad"]["circuit"],"closed")
            self.assertEqual(pool.snapshot()["active"],0)

    def test_latency_routing_and_expired_queue_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            pool=LlmPool([{"name":name,"capacity":1,"url":"http://unused","key":"test"}
                          for name in ["slow","fast"]],directory,clock=lambda:100)
            first=pool.acquire(110);second=pool.acquire(110)
            pool.release(first,status=200,elapsed_ms=50)
            pool.release(second,status=200,elapsed_ms=5)
            chosen=pool.acquire(110)
            self.assertEqual(chosen["name"],"fast")
            pool.release(chosen,status=200,elapsed_ms=5)
            with self.assertRaises(TimeoutError):pool.acquire(99)


class BufferedTransportTests(unittest.TestCase):
    def test_retry_is_hidden_capacity_released_and_audit_complete_without_socket(self):
        import io
        import urllib.error
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as directory:
            now=[100.0]
            pool=LlmPool([{'name':'test','capacity':1,'url':'http://test','key':'private-test-key'}],
                         directory,clock=lambda:now[0],proxy='')
            delays=[]
            def sleep(delay):
                self.assertEqual(pool.snapshot()['active'],0)
                delays.append(delay);now[0]+=delay
            pool.sleep=sleep
            body=b'{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}'
            class Response:
                status=200
                headers={'Content-Type':'application/json'}
                def __init__(self):
                    self.length=len(body)
                    self.fp=SimpleNamespace(raw=SimpleNamespace(_sock=SimpleNamespace(settimeout=lambda _:None)))
                def __enter__(self):return self
                def __exit__(self,*args):pass
                def isclosed(self):return self.length==0
                def read1(self,size):self.length=0;return body
            attempts=[]
            def open_request(request,timeout):
                attempts.append(request)
                if len(attempts)==1:
                    raise urllib.error.HTTPError('http://test',503,'temporary',{},io.BytesIO())
                return Response()
            pool.opener=SimpleNamespace(open=open_request)
            status,_,result=pool.complete(b'{}','reader')
            self.assertEqual(status,200)
            self.assertEqual(json.loads(result)['usage']['completion_tokens'],2)
            self.assertEqual(len(attempts),2)
            self.assertEqual(len(delays),1)
            self.assertEqual(pool.snapshot()['active'],0)
            events=[json.loads(line) for line in (Path(directory)/'requests.jsonl').read_text().splitlines()]
            self.assertEqual(sum(x['event']=='request_completed' for x in events),2)
            self.assertEqual(sum(x['event']=='retry' for x in events),1)
            self.assertNotIn('private-test-key',json.dumps(events))
