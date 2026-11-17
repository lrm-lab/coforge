# Staging desktop reverse tunnel

Operator steps and checks:
[staging desktop reverse tunnel](../../../docs/operations/cloud-swarm/staging-desktop-tunnel.md).

- Swarm manager: `coforge-staging-desktop-tunnel*.service` (SSH reverse tunnel).
- ECS `deploy` user: `desktop-tunnel-docker-relay.py` +
  `coforge-staging-desktop-docker-relay.user.service` (private-IP → loopback).
