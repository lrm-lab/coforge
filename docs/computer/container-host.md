# Computer container host

Part of [the documentation index](../../README.md). The Computer's `host/` runtime places one Swarm service per cloud Computer. Moved verbatim from `packages/computer/AGENTS.md`.

- `host/` polls the server over HTTPS and places one Swarm service per cloud
  Computer. It does not open a Daemon WebSocket or interpret Workspace messages.
  A container's `foreground` start, and `__attach-workspace`, write the Daemon
  API key and append one enabled workspace binding on the service volume.
  `__attach-workspace` then asks the running supervisor to start only that
  workspace. Agent workspaces are `/root/.coforge/agent-workspaces` on that volume.
  A second named volume at `/opt` keeps software installed there across an image replace. Home, the desktop, and `/root/.pi` stay on the writable layer and use the retained-image procedure. Removing the service removes both volumes. A disk format is this
  removal, then a create of the same computer id. An `update` job runs
  `docker service update --image --force` on that service and does not remove
  either volume. Heartbeats report node and `coforge-<id>` task image ids so Web
  can offer a replace when layers differ; the runtime version is display-only.
  `docker/Dockerfile` is the local image; its entrypoint is `coforge-computer foreground`. The proxied desktop page keeps `window.opener`; clearing it makes that window name unreachable.
