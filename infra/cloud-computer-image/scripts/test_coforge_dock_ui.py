#!/usr/bin/env python3
"""Dock visibility rules for the shared cloud desktop."""
import os
import unittest
from importlib.machinery import SourceFileLoader

HERE = os.path.dirname(os.path.abspath(__file__))
policy = SourceFileLoader(
    "coforge_dock_policy", os.path.join(HERE, "coforge_dock_policy.py")
).load_module()


class CoforgeDockUiTest(unittest.TestCase):
    def test_dock_stays_visible_on_the_shared_desktop(self):
        self.assertFalse(policy.dock_hides_when_idle())


if __name__ == "__main__":
    unittest.main()
