# Revision, runtime, and auth (sections 1–3)

Part of [OpenViking prototype public-runtime interface inventory](README.md).

## 1. Exact revision and license

| Fact | Value | Source |
| --- | --- | --- |
| Local checkout | `/home/zhoujie22/river2_0/OpenViking` | coordinator input; read-only |
| Remote | `https://github.com/volcengine/OpenViking.git` | `git remote -v` |
| HEAD | `e44ea6e11add1c7b3d4accdbfaf16e900a6049df` | `git rev-parse HEAD` |
| Commit date | 2026-09-21 15:43:04 +0800 | `git log -1` |
| Subject | `fix(plugins): honor cloud recall compression across harnesses (#5240)` | `git log -1` |
| Working tree | clean (`git status --porcelain` empty); HEAD is a grafted `main` | `git status` / `git log -1 --format='%D'` |
| License | GNU Affero General Public License v3 | `LICENSE` preamble; `pyproject.toml` `license = "AGPL-3.0"`; router files carry `SPDX-License-Identifier: AGPL-3.0` |
| Maturity | PyPI classifier `Development Status :: 3 - Alpha` | `pyproject.toml` |
| Package name | `openviking` | `pyproject.toml` `[project]` |

This pin is the prototype contract revision for later C1/C3/V1 work. Bumping it requires a new inventory, not a silent `main` follow.

AGPL use is not approved for a distributable product. This inventory confirms the local tree is AGPL-3.0; it does not change that gate.

## 2. Runtime compatibility

| Fact | Value | Source |
| --- | --- | --- |
| Language | Python 3 | `pyproject.toml` `requires-python = ">=3.10"`; classifiers list 3.10–3.14 |
| HTTP stack | FastAPI + Uvicorn | `pyproject.toml` dependencies `fastapi>=0.128.0`, `uvicorn>=0.39.0` |
| Default listen port | `1933` | official `docs/zh/guides/03-deployment.md` (`--port` default `1933`) |
| Health (liveness) | `GET /health`, unauthenticated | official `docs/zh/api/01-overview.md`, `docs/zh/api/07-system.md` |
| Readiness | `GET /ready` (AGFS, VectorDB, API Key manager), unauthenticated | official `docs/zh/api/01-overview.md` |
| Studio UI | `/studio` on the same origin when the bundle exists | official `docs/zh/guides/03-deployment.md`; source `openviking/server/app.py` |
| Vector backends | pluggable `CollectionAdapter` (`Local`, `Http`, `CuVS`, `VikingDBPrivate`, `Volcengine`) | source `openviking/storage/vectordb_adapters/` |
| LanceDB | not present as a first-class CoForge seam; later LanceDB belongs behind `CollectionAdapter` | source adapters above |

Official deployment docs also mention a compatibility Caddy listener on `1934` and hosted `ghcr.io/volcengine/openviking:latest`. Those are upstream operations notes, not CoForge default Compose. CoForge must not add OpenViking to default Compose, release, staging, or production while the license gate is open.

## 3. Auth, account, user, and ACL

Official identity model (`docs/zh/concepts/11-multi-tenant.md`, `docs/zh/guides/04-authentication.md`, `docs/zh/concepts/15-acl.md`):

- Tenant boundary is `account_id`. In-account user boundary is `user_id`.
- Built-in roles: `ROOT` (global), `ADMIN` (one account), `USER` (one account). Source also allows plugin-registered custom roles (`openviking/server/identity.py`).
- Shared resources live at `viking://resources/...` and are account-scoped. User memories, skills, and sessions are user-scoped.
- Isolation is request-context `account_id` + `user_id`, not directory naming. Physical paths are `/local/{account_id}/...`.
- ACL applies only to `viking://resources/...`. Levels: `read` < `write` < `manage`. Account `acl.enabled` defaults off.
- Auth modes: `api_key` (default), `trusted`, `oidc`, `ldap`, `dev`. Missing `root_api_key` in `api_key` mode becomes localhost-only development ROOT/`default/default`.

### Identity headers

Official HTTP identity headers (`docs/zh/api/01-overview.md`, `docs/zh/concepts/11-multi-tenant.md`, source `openviking/server/auth/__init__.py`):

| Header | Role | Notes |
| --- | --- | --- |
| `Authorization: Bearer <key>` | preferred API key | official overview |
| `X-API-Key` | alternate API key | official overview |
| `X-OpenViking-Account` | trusted-mode account assertion | ignored / must not be sent in `api_key` mode |
| `X-OpenViking-User` | trusted-mode user assertion | same |
| `X-OpenViking-Role` | trusted-mode `user` or `admin` assertion | `root` is rejected; requires configured `root_api_key` |
| `X-OpenViking-Actor-Peer` | peer-collection filter inside the current user | does not change tenant/user |

Source `openviking/server/auth/__init__.py` states that when an API key is present, spoofed `X-OpenViking-Account/User` headers are ignored. The policy gateway must still strip client-supplied identity/account headers and inject only the server-owned mapped identity.

Trusted mode can asynchronously register asserted account/user pairs (`docs/zh/guides/04-authentication.md`). CoForge typed provisioning should not rely on that side effect as the account/user source of truth.
