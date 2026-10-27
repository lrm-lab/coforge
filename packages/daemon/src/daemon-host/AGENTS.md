# daemon-host instructions

Rules for login-session startup in `src/daemon-host/`. They extend
`packages/daemon/AGENTS.md`.

- This directory owns startup through launchd, systemd user, and Windows task
  integration. It does not own Computer commands.
- Never fall back to a detached process when the platform manager is
  unavailable. Computer exposes foreground supervision as an explicit mode.
- Each host exposes `serviceDefinition()`, the text of its service file, built from the same value
  it writes. The Computer's `__lifecycle service-definition` hands that text to the installer; do
  not render a second copy anywhere.
