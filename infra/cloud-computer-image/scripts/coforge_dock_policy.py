"""Shared-desktop dock policy (no GTK)."""


def dock_hides_when_idle() -> bool:
    """The dock stays on so a phone can reach it while a computer keeps 1080p."""
    return False


def dock_height_px() -> int:
    """Tall enough that a phone tap at ~0.2–0.36 scale still hits an icon."""
    return 72


def dock_icon_px() -> int:
    return 56
