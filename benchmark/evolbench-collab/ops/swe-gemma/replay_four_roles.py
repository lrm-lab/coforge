"""Replay frozen group-chat material through the shared Gemma HTTP pool."""
import argparse
import collections
import concurrent.futures
import datetime
import hashlib
import json
import os
import shutil
import signal
import subprocess
import threading
import time
import urllib.request
from pathlib import Path
from four_role_results import write_final_summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--openviking', type=Path, required=True)
    parser.add_argument('--python', type=Path, required=True)
    parser.add_argument('--attempts', type=int, default=3)
    parser.add_argument('--attempt-policy', choices=['fixed', 'until-verified'], default='fixed')
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--pool-url', default='http://127.0.0.1:18740')
    args = parser.parse_args()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(args.pool_url+'/status', timeout=5) as response:
        assert json.load(response)['limit'] == 20, 'shared_pool_must_have_20_slots'
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    run = args.root/stamp
    run.mkdir(parents=True)
    (args.root/'latest.txt').write_text(str(run)+'\n')
    providers = json.loads((Path.home()/'.pi/agent/models.json').read_text())['providers']
    env = {**os.environ, 'LENOVO_GATEWAY_API_KEY': providers['lenovo-gemma']['apiKey'], 'LENOVO_GATEWAY_TIMEOUT_SECONDS': '960', 'NO_PROXY': 'localhost,127.0.0.1', 'no_proxy': 'localhost,127.0.0.1', 'SSL_CERT_FILE': str(Path.home()/'.pi/lenovo-ca-bundle.pem')}
    env.pop('DEV_MEMORY_API_KEY', None)
    jobs, provenance = [], []
    for index in range(20):
        source = args.source/f'm{index:02d}'
        case = run/source.name
        case.mkdir()
        hashes = {}
        for filename in ['attempts.jsonl', 'verdicts.jsonl']:
            shutil.copy2(source/filename, case/filename)
            hashes[filename] = hashlib.sha256((source/filename).read_bytes()).hexdigest()
        shutil.copytree(source/'sessions', case/'sessions')
        for path in sorted((source/'sessions').rglob('*')):
            if path.is_file(): hashes[str(path.relative_to(source))] = hashlib.sha256(path.read_bytes()).hexdigest()
        verdict = json.loads((case/'verdicts.jsonl').read_text().splitlines()[0])
        assert verdict['session_id'], 'missing_session_join'
        jobs.append({'index': index, 'episode_id': verdict['episode_id'], 'phase': 'queued', 'case_dir': str(case)})
        provenance.append({'index': index, 'source': str(source), 'sha256': hashes})
    config = {'source': str(args.source), 'group_chat_reused': 20, 'group_chat_rerun': 0, 'model': 'gemma-4-31B-it', 'roles': ['builder', 'critic', 'refiner', 'reader'], 'attempts': args.attempts, 'attempt_policy': args.attempt_policy, 'shared_http_limit': 20, 'pool_url': args.pool_url, 'workers': 20, 'source_revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=args.openviking, text=True).strip(), 'source_hashes': {name: hashlib.sha256((args.openviking/'benchmark/causal_memory'/name).read_bytes()).hexdigest() for name in ['aig0045_verdict_smoke.py', 'lenovo_gemma_provider.py', 'aig0045_gemma_roles.py']}}
    (run/'config.json').write_text(json.dumps(config, indent=2)+'\n')
    (run/'provenance.json').write_text(json.dumps(provenance, indent=2)+'\n')
    (run/'supervisor.json').write_text(json.dumps({'pid': os.getpid(), 'started_epoch': time.time()}, indent=2)+'\n')
    lock = threading.RLock()
    stopping = threading.Event()
    futures = []
    processes = {}
    def update(index, **fields):
        with lock:
            jobs[index].update(fields)
            tmp = run/'jobs.tmp'
            tmp.write_text(json.dumps(jobs, indent=2)+'\n'); tmp.replace(run/'jobs.json')
    def stop(signum, frame):
        stopping.set()
        for future in futures: future.cancel()
        with lock:
            children = list(processes.values())
            for process in children:
                if process.poll() is None: process.terminate()
        deadline = time.monotonic()+10
        for process in children:
            try: process.wait(timeout=max(.1, deadline-time.monotonic()))
            except subprocess.TimeoutExpired: process.kill(); process.wait()
        raise SystemExit(128+signum)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    def replay(index):
        case = run/f'm{index:02d}'
        command = [str(args.python), '-m', 'benchmark.causal_memory.aig0045_verdict_smoke', '--material', 'real', '--verdicts', str(case/'verdicts.jsonl'), '--sessions', str(case/'sessions'), '--builder', 'gemma', '--critic', 'gemma', '--refiner', 'gemma', '--reader', 'gemma', '--model', 'gemma-4-31B-it', '--url', args.pool_url+'/llm/v1/chat/completions', '--jobs', '1', '--attempts', str(args.attempts), '--attempt-policy', args.attempt_policy, '--max-calls', '128', '--max-seconds', '1800', '--out', str(case/'four-roles.json'), '--work-root', str(case/'four-roles-work')]
        manifest = args.manifest or args.source/'manifest.jsonl'
        if manifest.is_file(): command.extend(['--manifest', str(manifest)])
        try:
            with (case/'four-roles.log').open('wb') as log:
                with lock:
                    if stopping.is_set(): return
                    process = subprocess.Popen(command, cwd=args.openviking, env={**env, 'COFORGE_EVAL_LLM_CLIENT': f'four_roles:m{index:02d}'}, stdout=log, stderr=subprocess.STDOUT)
                    processes[index] = process
                update(index, phase='gemma_four_roles', pid=process.pid, started_epoch=time.time())
                try: code = process.wait(timeout=9000)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    try: process.wait(10)
                    except subprocess.TimeoutExpired: process.kill(); process.wait()
                    raise RuntimeError('four_roles_timeout')
            if code: raise RuntimeError(f'four_roles_exit_{code}')
            report = json.loads((case/'four-roles.json').read_text())
            rows = report['materials']
            assert len(rows) == 1
            row = rows[0]
            update(index, phase='done', finished_epoch=time.time(), submit=row.get('submit'), fallback=row.get('fallback_reason'), token_usage=report.get('token_usage'), **{key: row.get(key) for key in ['builder_submitted', 'graph_frozen', 'reader_verified', 'status']}, attempt_summary=report.get('attempt_summary'))
        except Exception as error:
            update(index, phase='failed', finished_epoch=time.time(), error=type(error).__name__+':'+str(error))
        finally:
            with lock: processes.pop(index, None)
    update(0)
    with concurrent.futures.ThreadPoolExecutor(max_workers=20) as executor:
        futures = [executor.submit(replay, index) for index in range(20)]
        while not all(f.done() for f in futures):
            with lock: status = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'phase_counts': dict(collections.Counter(j['phase'] for j in jobs))}
            try:
                with opener.open(args.pool_url+'/status', timeout=5) as response: status['pool'] = json.load(response)
            except Exception: status['pool_unavailable'] = True
            (run/'latest-status.json').write_text(json.dumps(status, indent=2)+'\n')
            print(json.dumps(status), flush=True)
            concurrent.futures.wait(futures, timeout=30)
    summary = write_final_summary(run, config, jobs)
    print(json.dumps({'run': str(run), 'phase_counts': summary['phase_counts']}), flush=True)


if __name__ == '__main__': main()
