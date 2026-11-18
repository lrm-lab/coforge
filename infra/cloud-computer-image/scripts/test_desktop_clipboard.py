"""UTF-8 clipboard owner replaces a previous owner and rejects oversize text."""

from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


HERE = os.path.dirname(os.path.abspath(__file__))


def load_module():
    path = os.path.join(HERE, "desktop_clipboard.py")
    spec = importlib.util.spec_from_file_location("desktop_clipboard", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class DesktopClipboardTests(unittest.TestCase):
    def setUp(self):
        self.module = load_module()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        os.environ["XDG_RUNTIME_DIR"] = self.tmp.name

    def test_rejects_empty_and_oversize(self):
        with self.assertRaises(self.module.ClipboardError) as empty:
            self.module.set_clipboard(":1", "")
        self.assertEqual(empty.exception.code, "empty")
        with self.assertRaises(self.module.ClipboardError) as large:
            self.module.set_clipboard(":1", "x" * (self.module.MAX_CLIPBOARD_BYTES + 1))
        self.assertEqual(large.exception.code, "too_large")

    def test_rejects_bad_display(self):
        with self.assertRaises(self.module.ClipboardError) as bad:
            self.module.set_clipboard("1", "hi")
        self.assertEqual(bad.exception.code, "bad_display")

    def test_spawns_owner_and_stops_previous(self):
        killed: list[int] = []

        def fake_kill(pid: int, sig: int = 0):
            if sig == 0:
                if pid in killed:
                    raise OSError("gone")
                return None
            killed.append(pid)

        with (
            mock.patch.object(self.module.os, "spawnv", return_value=4242) as spawn,
            mock.patch.object(self.module.os, "kill", side_effect=fake_kill),
            mock.patch.object(self.module.time, "sleep"),
        ):
            pid_path, bin_path = self.module._state_paths(":1")
            pid_path.write_text("111\n", encoding="utf-8")
            self.module.set_clipboard(":1", "你好", xauthority="/tmp/xauth")
            self.assertEqual(bin_path.read_bytes(), "你好".encode("utf-8"))
            self.assertEqual(pid_path.read_text(encoding="utf-8").strip(), "4242")
            self.assertEqual(killed[0], 111)
            args = spawn.call_args[0][2]
            self.assertEqual(args[1], str(Path(HERE) / "desktop_clipboard.py"))
            self.assertEqual(args[2], "--serve")
            self.assertEqual(args[3], ":1")


if __name__ == "__main__":
    unittest.main()
