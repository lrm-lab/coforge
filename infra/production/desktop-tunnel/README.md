# Production desktop reverse tunnel

Operator steps and checks:
[production desktop reverse tunnel](../../../docs/operations/cloud-swarm/production-desktop-tunnel.md).

- Swarm manager: `coforge-production-desktop-tunnel*.service` (SSH reverse tunnel).
- ECS `deploy` user: `desktop-tunnel-docker-relay.py` +
  `coforge-production-desktop-docker-relay.user.service` (private-IP → loopback).
