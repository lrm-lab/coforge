"""Shared-desktop dock policy (no GTK)."""


def dock_hides_when_idle() -> bool:
    """The dock stays on so a phone can reach it while a computer keeps 1080p."""
    return False
