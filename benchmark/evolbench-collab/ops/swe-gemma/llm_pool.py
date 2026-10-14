"""One local, bounded Gemma request pool for Task, Memory and four-role clients.

Only inference requests are retried. Responses are buffered until complete, so
failed streams cannot emit partial tool calls into an agent conversation.
"""
import argparse
import collections
import datetime
import email.utils
import hmac
import http.client
import json
import os
import random
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RETRYABLE = {408, 429, 500, 502, 503, 504}
CAPACITIES = {'lenovo-gemma': 4, 'gemma-4-31b-it-2gpu-1': 8, 'gemma-4-31b-it-2gpu-2': 8}


class LlmPool:
    def __init__(self, endpoints, directory, *, sleep=time.sleep, proxy=None, budget_seconds=900, clock=time.monotonic):
        self.endpoints = endpoints
        self.clock = clock
        self.health = {e["name"]: {"attempts": 0, "successes": 0, "failures": 0, "consecutive_failures": 0, "ewma_latency_ms": None, "open_until": 0, "probe": False} for e in endpoints}
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.condition = threading.Condition()
        self.audit_lock = threading.Lock()
        self.active = collections.Counter()
        self.peak = self.waiting = self.started = self.finished = self.retries = 0
        self.cursor = 0
        self.sleep = sleep
        self.budget_seconds = budget_seconds
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({} if proxy == '' else None))
        self.audit_path = self.directory/'requests.jsonl'

    def authenticated(self, authorization):
        supplied = authorization.removeprefix('Bearer ')
        return any(hmac.compare_digest(supplied, endpoint['key']) for endpoint in self.endpoints)

    def snapshot(self):
        with self.condition:
            return {'limit': sum(e['capacity'] for e in self.endpoints), 'active': sum(self.active.values()),
                    'peak_active': self.peak, 'queued': self.waiting, 'http_attempts': self.started,
                    'completed_attempts': self.finished, 'retries': self.retries, 'retry_policy': {'max_retries': 6, 'budget_seconds': self.budget_seconds, 'base_delay_seconds': 15, 'max_delay_seconds': 120, 'jitter_seconds': 5},
                    'endpoints': {e['name']: {'limit': e['capacity'], 'active': self.active[e['name']], **self.health[e['name']], 'circuit': ('half_open' if self.health[e['name']]['probe'] else 'open' if self.health[e['name']]['open_until'] > self.clock() else 'closed'), 'cooldown_remaining_seconds': max(0, self.health[e['name']]['open_until']-self.clock())} for e in self.endpoints}}

    def record(self, event, **fields):
        blob = (json.dumps({'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'event': event, **fields})+'\n').encode()
        with self.audit_lock:
            fd = os.open(self.audit_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                if os.write(fd, blob) != len(blob): raise OSError('incomplete_audit_write')
            finally: os.close(fd)

    def acquire(self, deadline):
        with self.condition:
            self.waiting += 1
            try:
                while True:
                    now = self.clock()
                    remaining = deadline-now
                    if remaining <= 0: raise TimeoutError('pool_queue_timeout')
                    candidates = []
                    wake_in = remaining
                    for offset in range(len(self.endpoints)):
                        index = (self.cursor+offset) % len(self.endpoints)
                        endpoint = self.endpoints[index]
                        name = endpoint['name']
                        state = self.health[name]
                        if state['open_until'] > now:
                            wake_in = min(wake_in, state['open_until']-now)
                            continue
                        if state['probe'] or self.active[name] >= endpoint['capacity']:
                            continue
                        if state['open_until'] and self.active[name]:
                            continue
                        score = (-1 if state['open_until'] else
                                 (state['ewma_latency_ms'] or 0)
                                 * (1+self.active[name]/endpoint['capacity'])
                                 * (1+3*state['consecutive_failures']))
                        candidates.append((score, offset, index, endpoint))
                    if candidates:
                        _, _, index, endpoint = min(candidates, key=lambda item: item[:2])
                        state = self.health[endpoint['name']]
                        if state['open_until']: state['probe'] = True
                        self.cursor = (index+1) % len(self.endpoints)
                        self.active[endpoint['name']] += 1
                        self.started += 1
                        self.peak = max(self.peak, sum(self.active.values()))
                        return endpoint
                    self.condition.wait(wake_in)
            finally: self.waiting -= 1

    def release(self, endpoint, *, status=None, elapsed_ms=0, retryable=False):
        with self.condition:
            name = endpoint['name']
            state = self.health[name]
            if status is not None or retryable:
                state['attempts'] += 1
                if status == 200 and not retryable:
                    state['successes'] += 1
                    state['consecutive_failures'] = 0
                    state['open_until'] = 0
                    previous = state['ewma_latency_ms']
                    state['ewma_latency_ms'] = elapsed_ms if previous is None else .8*previous+.2*elapsed_ms
                elif retryable:
                    state['failures'] += 1
                    state['consecutive_failures'] += 1
                    if state['consecutive_failures'] >= 2:
                        state['open_until'] = self.clock()+60
                else:
                    state['failures'] += 1
            state['probe'] = False
            self.active[name] -= 1
            self.finished += 1
            self.condition.notify_all()

    def complete(self, body, client):
        request_id = uuid.uuid4().hex
        deadline = self.clock()+self.budget_seconds
        for attempt in range(7):
            endpoint = self.acquire(deadline)
            status, content_type, blob, retry_after, usage = 0, 'application/json', b'', 0, None
            started = self.clock()
            retry = False
            try:
                self.record('request_started', request_id=request_id, client=client, endpoint=endpoint['name'], attempt=attempt)
                request = urllib.request.Request(endpoint['url'], data=body, headers={'Authorization': 'Bearer '+endpoint['key'], 'Content-Type': 'application/json'})
                with self.opener.open(request, timeout=max(.1, min(120, deadline-self.clock()))) as response:
                    status = response.status
                    content_type = response.headers.get('Content-Type', 'application/json')
                    # urllib exposes the underlying socket through its HTTPResponse buffer.
                    # Tighten each read to the remaining total deadline, including slow streams.
                    socket = response.fp.raw._sock
                    parts = []
                    size = 0
                    while True:
                        if response.isclosed() or response.length == 0: break
                        remaining = deadline-self.clock()
                        if remaining <= 0: raise TimeoutError('model_response_deadline')
                        socket.settimeout(min(120, remaining))
                        chunk = response.read1(65536)
                        if not chunk: break
                        parts.append(chunk)
                        size += len(chunk)
                        if size > 32*1024*1024: raise ValueError('model_response_too_large')
                    blob = b''.join(parts)
                    if 'text/event-stream' in content_type:
                        if not any(line.strip() == b'data: [DONE]' for line in blob.splitlines()):
                            raise http.client.IncompleteRead(blob)
                        for line in blob.splitlines():
                            if line.startswith(b'data: ') and line.strip() != b'data: [DONE]':
                                payload = json.loads(line[6:])
                                if payload.get('usage'): usage = payload['usage']
                    else:
                        payload = json.loads(blob)
                        usage = payload.get('usage') if isinstance(payload, dict) else None
            except urllib.error.HTTPError as error:
                status = error.code
                retry = status in RETRYABLE
                # Permanent failures remain visible; no response body or credential is logged.
                blob = json.dumps({'error': {'message': 'llm_http_error', 'status': status}}).encode()
                value = error.headers.get('Retry-After', '') if error.headers else ''
                try: retry_after = max(0, float(value))
                except ValueError:
                    try: retry_after = max(0, email.utils.parsedate_to_datetime(value).timestamp()-time.time())
                    except (ValueError, TypeError, OverflowError): pass
            except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException):
                retry = True
            finally:
                elapsed_ms = round((self.clock()-started)*1000)
                self.release(endpoint, status=status or None, elapsed_ms=elapsed_ms, retryable=retry)
                self.record('request_completed', request_id=request_id, client=client, endpoint=endpoint['name'], attempt=attempt,
                            http_status=status or None, elapsed_ms=elapsed_ms, usage=usage, retryable=retry)
            if not retry: return status, content_type, blob
            delay = max(retry_after, min(120, 15*(2**attempt)+random.uniform(0, 5)))
            if attempt == 6 or self.clock()+delay >= deadline: break
            with self.condition: self.retries += 1
            self.record('retry', request_id=request_id, client=client, attempt=attempt, delay_seconds=delay)
            self.sleep(delay)
        # Non-retryable transport result prevents multiplying this budget with SDK retries.
        self.record('exhausted', request_id=request_id, client=client)
        return 424, 'application/json', b'{"error":{"message":"llm_transport_exhausted","type":"transport_failure"}}'


class PoolServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, pool):
        self.pool = pool
        super().__init__(address, PoolHandler)


class PoolHandler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def reply(self, status, content_type, body):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path != '/status': return self.reply(404, 'application/json', b'{}')
        self.reply(200, 'application/json', json.dumps(self.server.pool.snapshot()).encode())
    def do_POST(self):
        if self.path != '/llm/v1/chat/completions': return self.reply(404, 'application/json', b'{}')
        if not self.server.pool.authenticated(self.headers.get('Authorization', '')):
            return self.reply(401, 'application/json', b'{"error":"unauthorized"}')
        length = int(self.headers.get('Content-Length', '0'))
        if not 0 < length <= 16*1024*1024: return self.reply(413, 'application/json', b'{}')
        body = self.rfile.read(length)
        try:
            if json.loads(body).get('model', '').lower() != 'gemma-4-31b-it':
                return self.reply(400, 'application/json', b'{"error":"unsupported_model"}')
            result = self.server.pool.complete(body, self.headers.get('X-Coforge-LLM-Client', 'unspecified')[:128])
        except (TimeoutError, ConnectionError):
            result = (424, 'application/json', b'{"error":{"message":"llm_transport_exhausted"}}')
        except Exception:
            result = (500, 'application/json', b'{"error":{"message":"local_pool_error"}}')
        try: self.reply(*result)
        except (BrokenPipeError, ConnectionError): pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=18740)
    parser.add_argument('--directory', type=Path, required=True)
    args = parser.parse_args()
    providers = json.loads((Path.home()/'.pi/agent/models.json').read_text())['providers']
    endpoints = []
    for name, capacity in CAPACITIES.items():
        provider = providers[name]
        endpoints.append({'name': name, 'capacity': capacity, 'url': provider['baseUrl'].rstrip('/')+'/chat/completions', 'key': provider['apiKey']})
    pool = LlmPool(endpoints, args.directory)
    server = PoolServer(('127.0.0.1', args.port), pool)
    public = {'pid': os.getpid(), 'url': f'http://127.0.0.1:{args.port}', **pool.snapshot()}
    (args.directory/'server.json').write_text(json.dumps(public, indent=2)+'\n')
    print(json.dumps(public), flush=True)
    server.serve_forever()


if __name__ == '__main__': main()
