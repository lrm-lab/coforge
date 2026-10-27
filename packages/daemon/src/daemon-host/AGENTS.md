# daemon-host instructions

Rules for login-session startup in `src/daemon-host/`. They extend
`packages/daemon/AGENTS.md`.

- This directory owns startup through launchd, systemd user, and Windows task
  integration. It does not own Computer commands.
- Never fall back to a detached process when the platform manager is
  unavailable. Computer exposes foreground supervision as an explicit mode.
- Each host exposes `serviceDefinition()`, the text of its service file and, where the manager keeps
  one on disk, its `path`, built from the same values it writes. The Computer's
  `__lifecycle service-definition` hands the text (not the path) to the installer, and `status`
  compares the file at `path` with it; do not render a second copy anywhere.
