# coforge-staging: cloud staging environment

Status: **workflow ready; credentials pending operator provisioning.**

The approved cloud application track runs as the `coforge-staging` Compose
project on a single ECS host. Caddy owns the only public entry (trusted
HTTPS on 443); application ports stay private and reach the host only through
loopback diagnostics (`18080` web, `18000` centrifugo). HTTPS responses carry
HSTS, and port 80 serves only the permanent redirect to the same URL over
HTTPS.

The same Caddy also fronts apps hosted on this machine: `research.coforge.cn`
is PiResearch, its own Compose project on the `coforge-staging-apps` network,
deployed from its own repository. Staging does not depend on it.

Web reaches staging only when an operator dispatches **Deploy Web (staging)**
from `main`; a merge to `main` does not deploy
([Main to staging](../../release/main-to-staging.md#cloud-application)):

```sh
gh workflow run deploy-staging.yml --repo lrm-lab/coforge --ref main
```

## Web-page artifacts' origins

Staging serves each web-page artifact from `a-<artifact uuid>.staging.coforgeusercontent.com`
(`COFORGE_ARTIFACT_SANDBOX_ORIGIN` is `https://staging.coforgeusercontent.com`); the bare host
answers not found. DNS needs a wildcard record for `*.staging.coforgeusercontent.com`, and its
certificate needs a DNS-01 issuer, as described in the
[production runbook](../production/README.md#web-page-artifacts-origins).

## Contents

- [One-time operator bootstrap](operator-bootstrap.md): One-time host bootstrap: deployment user, secrets, RAM role, CDN signing key, DNS, and the first deploy.
- [Container logs](container-logs.md): The journald logging driver, moving the journal to the data disk, and reading logs.
- [GitHub Environment secrets (repository `staging` environment)](github-environment.md): GitHub Environment secrets and variables, bulk configuration, and when each kind of value takes effect.
- [触发 Computer 本地分发发布](computer-release-trigger.md): Triggering a local Computer distribution release to staging, and why published versions are immutable.
- [在 staging 上启用云电脑](../cloud-swarm/staging-bring-up.md): Staging Swarm token, Computer publish, computer image, and the manager `host` process.
- [User-content wildcard certificate](../usercontent-certificate/README.md): The Caddy DNS-01 issuer for `*.staging.coforgeusercontent.com`, its RAM user and secrets.
- [Personal GitHub connection](github-connection.md): The staging GitHub App configuration, its Environment values, and manual acceptance.
