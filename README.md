# Coforge

Coforge is a private and group chat product for working with code agents that
run inside local workspaces. The cloud owns conversations and durable message
delivery; local workspace processes connect outbound and adapt resident agent
runtimes through provider-neutral code-agent adapters.

## Architecture

```text
Browser -> Caddy -> TanStack Start / Bun backend -> PostgreSQL
              \--> standalone Centrifugo <-one WSS- coforge-daemon
                          |      |
                       Redis    | HTTP/gRPC proxy + server API
                                +---- backend

coforge-computer <-Unix socket-> coforge-daemon -> N Agent runtime OS children
```

- Web/backend: TanStack Start with Bun 1.4; PostgreSQL through Prisma
- Realtime transport: standalone Centrifugo OSS over WebSocket, Redis for hot state
- Local product: one `coforge-computer` executable containing the Computer and
  Daemon roles, which run as separate OS processes
- Edge and deployment: Caddy and Docker; tool versions pinned by mise

The architecture invariants every change must respect are in
[AGENTS.md](AGENTS.md#architecture-invariants).

## Documentation

| Document | Covers |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Repository rules: decisions, module design, delivery, toolchain, architecture invariants |
| [apps/web/AGENTS.md](apps/web/AGENTS.md) | Web/backend rules and module map |
| [apps/docs/AGENTS.md](apps/docs/AGENTS.md) | Public developer docs site (VitePress): commands, locales, llms.txt and schema rules |
| [packages/computer/AGENTS.md](packages/computer/AGENTS.md) | Computer package rules and module map |
| [packages/agent/AGENTS.md](packages/agent/AGENTS.md) | Agent runtime rules and module map |
| [packages/daemon/AGENTS.md](packages/daemon/AGENTS.md) | Daemon package rules and module map |
| [packages/anvil/AGENTS.md](packages/anvil/AGENTS.md) | Anvil contracts, adapters, execution and host boundary rules |
| [crates/installer/AGENTS.md](crates/installer/AGENTS.md) | Rust installer crate (`coforge-installer`): toolchain, commands, contract, CI, supply-chain gate |
| [crates/installer/src/AGENTS.md](crates/installer/src/AGENTS.md) | Installer module map and install-layout rules |
| [docs/workspace-assistant.md](docs/workspace-assistant.md) | Workspace platform assistant setup, isolated sessions, and backfill |
| [docs/pi-chat/README.md](docs/pi-chat/README.md) | Independent cloud Pi conversations, signed host access, native history, deployment and acceptance |
| [docs/database-schema/](docs/database-schema/README.md) | Database schema and conversation/delivery model |
| [docs/memory-disposition.md](docs/memory-disposition.md) | Target-only Memory Hint receipts, configuration, and validation |
| [docs/reliable-message-delivery.md](docs/reliable-message-delivery.md) | Message delivery guarantees |
| [docs/workspace-deletion.md](docs/workspace-deletion.md) | What deleting a Workspace removes, and when |
| [docs/authorization-server/](docs/authorization-server/README.md) | "Login with CoForge": the OpenID Connect authorization server for third-party apps, its configuration and endpoints |
| [docs/app-bot/](docs/app-bot/README.md) | App Bot: an app's managed Agent per Workspace - declare, grant, the bot key and status line, what the key may call |
| [docs/app-notifications.md](docs/app-notifications.md) | App notifications: the pg-boss outbox that records events in the domain transaction and fans them out to installed apps |
| [docs/app-agent-events/](docs/app-agent-events/README.md) | App events for an Agent (Agent inbound): scopes, approval, the Agent-bound token, the dedicated conversation, and the HTTP API |
| [docs/app-marketplace.md](docs/app-marketplace.md) | App Marketplace: publish and offline review, installing a listed app, private share links, the platform operator who decides, and the first operator's grant |
| [docs/feature-flags.md](docs/feature-flags.md) | Feature flags: turning a dark feature on per Workspace with a flagd definition file |
| [docs/observability/](docs/observability/README.md) | Agent Activity, status, and observability baseline |
| [docs/local-gemma-evaluation.md](docs/local-gemma-evaluation.md) | Local SWE evaluation, Gemma service management, Docker and token audits |
| [benchmark/evolbench-collab/ops/swe-gemma/README.md](benchmark/evolbench-collab/ops/swe-gemma/README.md) | SWE Docker Task runtime and independent 20-worker evaluation pools |
| [benchmark/harness/README.md](benchmark/harness/README.md) | Eval computer shared by the collaborative benchmarks |
| [docs/agents/daemon-message-attention.md](docs/agents/daemon-message-attention.md) | Daemon message delivery, recovery and attention rules |
| [docs/local-logging.md](docs/local-logging.md) | Computer/Daemon logging contract |
| [docs/release/](docs/release/README.md) | Release contract: deployment, Computer distribution, installer feed, promotion, rollback |
| [docs/design/](docs/design/README.md) | Product UI design guidance |
| [docs/design-tokens.md](docs/design-tokens.md) | Design tokens |
| [docs/operations/aliyun-oss-cdn/](docs/operations/aliyun-oss-cdn/README.md) | OSS/CDN provisioning runbook |
| [docs/operations/cdn-certificates/](docs/operations/cdn-certificates/README.md) | CDN certificate renewal runbook |
| [docs/agents/testing.md](docs/agents/testing.md) | Testing guidance for agents |
| [docs/agents/shared-agent-skills.md](docs/agents/shared-agent-skills.md) | Project skills, independent review, release and reference-research rules every agent follows |
| [docs/agents/e2e-testing/](docs/agents/e2e-testing/README.md) | Live OpenRouter integration test |
| [docs/agents/mise-tasks.md](docs/agents/mise-tasks.md) | Mise task policy |
| [docs/agents/git-hooks/](docs/agents/git-hooks/README.md) | Pre-commit file size limit and its ratchet, the hard rules the hook and CI enforce, the hook check in `mise run check`, and marking generated files |
| [docs/agents/reference-cli-research/](docs/agents/reference-cli-research/README.md) | Studying the latest Raft Computer reference binary, source tree, and installer |
| [docs/agents/grok-acp.md](docs/agents/grok-acp.md) | Persistent Grok ACP behavior, compatibility and native verification |
| [docs/research/](docs/research/README.md) | Evidence-backed research reports |
| [apps/web/README.md](apps/web/README.md) | Web app setup and scripts |
| [apps/web/assets/mascots/README.md](apps/web/assets/mascots/README.md) | Agent mascot Rive file: generator, runtime contract, static avatars, Rive CLI pin |
| [apps/web/src/components/ui/README.md](apps/web/src/components/ui/README.md) | UI component inventory and exceptions |
| [packages/computer/README.md](packages/computer/README.md) | `coforge-computer` package |
| [packages/daemon/README.md](packages/daemon/README.md) | `coforge-daemon` package |
| [packages/anvil/README.md](packages/anvil/README.md) | `@lrm/coforge-anvil` Agent contracts, runtime adapters and shared execution |
| [packages/agent/README.md](packages/agent/README.md) | Built-in Pi-based Agent runtime |
| [packages/coforge/README.md](packages/coforge/README.md) | Agent-facing `coforge` CLI and its module map |
| [docs/agent-cli/](docs/agent-cli/README.md) | `coforge` Agent CLI command reference |
| [docs/agent-manifest/](docs/agent-manifest/README.md) | `coforge-agent-manifest.v1`: the public JSON document an app publishes to tell Agents what it can do, its limits, and examples |
| [packages/coforge-sdk/README.md](packages/coforge-sdk/README.md) | Shared contracts and transports |
| [infra/README.md](infra/README.md) | Local Docker Compose services |
| [docs/operations/cloud-swarm/](docs/operations/cloud-swarm/README.md) | Attach one Swarm cluster when standing up a CoForge deployment |
| [docs/operations/staging/](docs/operations/staging/README.md) | Staging environment runbook |
| [docs/operations/production/](docs/operations/production/README.md) | Production environment runbook |
| [docs/operations/openviking-prototype/](docs/operations/openviking-prototype/README.md) | Non-production OpenViking prototype runtime: gates, enable/disable, data lifecycle, known issues, smoke |
| [infra/production/README.md](infra/production/README.md) | Production Compose environment (points to its runbook) |

Project skills live in `.agents/skills`; `skills-lock.json` pins the upstream ones.

## Repository layout

```text
apps/web                Web UI and backend control plane
apps/docs               Public developer docs site (VitePress, English and zh-CN)
packages/computer       Machine-level setup and supervisor package component
packages/daemon         Single-workspace daemon package component
packages/anvil          Agent contracts, runtime adapters and shared execution
packages/agent          Independently packable built-in Agent runtime using Pi SDK
packages/coforge        Agent CLI
packages/coforge-sdk    Shared protocol and Agent SDK
crates/installer        Rust installer (coforge-installer) for Computer installations
docs                    Project documentation
infra                   Local and staging deployment
```

## Development

Install the pinned toolchain and dependencies:

```bash
mise install
mise run setup
```

Run tests first, then repository checks and production builds:

```bash
mise run test
mise run check
mise run build
```

Every change goes through a short-lived branch and an approved PR; see
[AGENTS.md](AGENTS.md#collaboration-and-delivery).

- [docs/eval-memory-requests.md](docs/eval-memory-requests.md): Task 主动 @memory 的评测协议、IR 数据准备与冻结 test。
