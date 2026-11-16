#!/usr/bin/env python3
"""Per-agent screen allocation, without starting TigerVNC."""
import os
import tempfile
import time
import unittest

from importlib.machinery import SourceFileLoader

HERE = os.path.dirname(os.path.abspath(__file__))
screen = SourceFileLoader(
    "vnc_agent_screen", os.path.join(HERE, "vnc-agent-screen.py")
).load_module()


class FakeProcess:
    def __init__(self):
        self.dead = False

    def poll(self):
        return 0 if self.dead else None

    def terminate(self):
        self.dead = True

    def wait(self, timeout=None):
        self.dead = True
        return 0

    def kill(self):
        self.dead = True


class AgentScreenTest(unittest.TestCase):
    def test_screen_path(self):
        self.assertEqual(screen.screen_target("/screen/agent-1"), ("agent-1", "page"))
        self.assertEqual(
            screen.screen_target("/screen/agent-1/desktop.html"), ("agent-1", "page")
        )
        self.assertEqual(
            screen.screen_target("/screen/agent-1/websockify"), ("agent-1", "socket")
        )
        self.assertEqual(
            screen.screen_target("/screen/agent-1/core/rfb.js"), ("agent-1", "core/rfb.js")
        )
        self.assertIsNone(screen.screen_target("/desktop.html"))
        self.assertIsNone(screen.screen_target("/screen/agent-1/../passwd"))

    def test_hold_isolates_one_display_and_release_stops_it(self):
        root = tempfile.mkdtemp(prefix="coforge-screen-")
        launched = []

        def launch(spec):
            launched.append(spec)
            with open(os.path.join(spec["directory"], "bus"), "w", encoding="utf-8") as handle:
                handle.write("unix:path=/tmp/agent-bus")
            return FakeProcess()

        screens = screen.AgentScreens(
            root=root, launch=launch, idle_seconds=0.05, bus_timeout=0.2
        )
        first = screens.hold("agent-1")
        second = screens.hold("agent-1")
        other = screens.hold("agent-2")
        self.assertEqual(len(launched), 2)
        self.assertEqual(first["display"], second["display"])
        self.assertEqual(screens.lookup("agent-1"), {"display": first["display"]})
        self.assertIsNone(screens.lookup("missing"))
        self.assertNotEqual(first["display"], other["display"])
        self.assertNotEqual(first["configHome"], other["configHome"])
        self.assertTrue(first["configHome"].endswith("/agent-1/config"))
        self.assertEqual(first["dbus"], "unix:path=/tmp/agent-bus")
        self.assertEqual(len(first["cdpToken"]), 32)
        self.assertIn(first["cdpToken"], first["cdpEndpoint"])
        self.assertEqual(first["cdpPort"], 9222 + int(first["display"].lstrip(":")))
        with open(launched[0]["xstartup"], encoding="utf-8") as handle:
            text = handle.read()
            self.assertIn("export DISPLAY=", text)
            self.assertIn("export COFORGE_CDP_TOKEN=", text)

        port = screens.open_viewer("agent-1")
        self.assertEqual(port, launched[0]["port"])
        screens.release("agent-1")
        screens.close_viewer("agent-1")
        time.sleep(0.3)
        again = screens.hold("agent-1")
        self.assertEqual(len(launched), 3)
        self.assertNotEqual(again["display"], other["display"])
        screens.release("agent-2")
        time.sleep(0.3)
        screens.hold("agent-2")
        self.assertEqual(len(launched), 4)


if __name__ == "__main__":
    unittest.main()
