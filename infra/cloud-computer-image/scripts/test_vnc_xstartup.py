#!/usr/bin/env python3
"""Shared and Agent VNC sessions must not blank the remote desktop."""
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))


class VncXstartupTest(unittest.TestCase):
    def test_shared_desktop_disables_screen_blanking(self):
        with open(os.path.join(HERE, "vnc-xstartup"), encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("xset s off", text)
        self.assertIn("xset s noblank", text)

    def test_agent_desktop_disables_screen_blanking(self):
        with open(os.path.join(HERE, "vnc-agent-xstartup"), encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("xset s off", text)
        self.assertIn("xset s noblank", text)


if __name__ == "__main__":
    unittest.main()
