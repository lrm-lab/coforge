"""Owned evaluation resources: endpoint capacity, processes, and containers."""
import collections
import json
import os
import signal
import subprocess
import threading
import time
from pathlib import Path


class EndpointPool:
    def __init__(self, endpoints):
        self._free = collections.deque(endpoints)
        self._condition = threading.Condition()

    def acquire(self, preferred=None, timeout=None):
        with self._condition:
            ready = self._condition.wait_for(
                lambda: bool(self._free) if preferred is None else preferred in self._free,
                timeout=timeout,
            )
            if not ready:
                raise TimeoutError("endpoint_capacity_exhausted")
            if preferred is None:
                return self._free.popleft()
            self._free.remove(preferred)
            return preferred

    def release(self, endpoint):
        with self._condition:
            self._free.append(endpoint)
            self._condition.notify_all()


def process_identity(pid):
    try:
        fields = (Path('/proc')/str(pid)/'stat').read_text().rsplit(')', 1)[1].split()
        return None if fields[0] == 'Z' else fields[19]
    except OSError:
        return None


def stop_owned_process(pid, identity, *, group=False, timeout=10):
    if not identity or process_identity(pid) != identity:
        return False
    if group and os.getpgid(pid) != pid:
        raise RuntimeError('process_group_ownership_mismatch')
    def send(sig):
        if process_identity(pid) != identity:
            return
        try:
            (os.killpg if group else os.kill)(pid, sig)
        except ProcessLookupError:
            pass
    send(signal.SIGTERM)
    deadline = time.monotonic()+timeout
    while process_identity(pid) == identity and time.monotonic() < deadline:
        time.sleep(.05)
    if process_identity(pid) == identity:
        send(signal.SIGKILL)
    return True


def archive_owned_container(name, workspace, base_commit, patch_path, env, *, run=subprocess.run):
    if not workspace:
        raise RuntimeError('container_ownership_unknown')
    info = run(['docker', 'inspect', name], env=env, capture_output=True, text=True, timeout=15)
    if info.returncode:
        return None
    containers = json.loads(info.stdout)
    if len(containers) != 1 or containers[0]['Config'].get('Labels', {}).get('coforge.eval.task.workspace') != workspace:
        raise RuntimeError('container_ownership_mismatch')
    diff = run(['docker', 'exec', '-w', '/testbed', name, 'git', 'diff', base_commit, '--binary'],
               env=env, capture_output=True, timeout=30)
    if diff.returncode:
        raise RuntimeError('candidate_patch_archive_failed')
    Path(patch_path).write_bytes(diff.stdout)
    # Remove by immutable ID after checking ownership, even if a same-name replacement appears.
    removed = run(['docker', 'rm', '-f', containers[0]['Id']], env=env, capture_output=True, timeout=30)
    if removed.returncode:
        raise RuntimeError('owned_container_remove_failed')
    return len(diff.stdout)
