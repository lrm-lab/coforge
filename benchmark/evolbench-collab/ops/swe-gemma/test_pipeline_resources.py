import collections
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from pipeline_resources import EndpointPool, archive_owned_container, process_identity, stop_owned_process


class ResourceOwnershipTests(unittest.TestCase):
    def test_recovered_job_reserves_its_provider_capacity(self):
        pool = EndpointPool(["a"] * 8 + ["b"] * 8 + ["gateway"] * 4)
        self.assertEqual(pool.acquire("a"), "a")
        assignments = [pool.acquire() for _ in range(19)]
        self.assertEqual(collections.Counter(["a", *assignments]), {"a": 8, "b": 8, "gateway": 4})
        with self.assertRaises(TimeoutError):
            pool.acquire("a", timeout=0)
        pool.release("a")
        self.assertEqual(pool.acquire("a", timeout=0), "a")

    def test_reused_pid_is_never_signalled(self):
        with patch("pipeline_resources.process_identity", return_value="new"), patch("pipeline_resources.os.kill") as kill:
            self.assertFalse(stop_owned_process(12345, "old"))
        kill.assert_not_called()

    def test_owned_process_group_is_reaped(self):
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"], start_new_session=True)
        try:
            self.assertTrue(stop_owned_process(proc.pid, process_identity(proc.pid), group=True))
            self.assertIsNotNone(proc.wait(timeout=2))
        finally:
            if proc.poll() is None:
                proc.kill(); proc.wait()

    def test_foreign_container_is_never_removed(self):
        commands = []
        def run(args, **kwargs):
            commands.append(args)
            return SimpleNamespace(returncode=0, stdout=json.dumps([{
                "Config": {"Labels": {"coforge.eval.task.workspace": "/foreign/workspace"}}
            }]))
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "ownership"):
                archive_owned_container("swe-case", "/this/workspace", "base", Path(directory)/"patch", {}, run=run)
        self.assertEqual(len(commands), 1)
        self.assertEqual(commands[0][:2], ["docker", "inspect"])


if __name__ == "__main__":
    unittest.main()
