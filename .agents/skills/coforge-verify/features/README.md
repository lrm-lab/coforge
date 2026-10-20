# Feature Map

How to reach, drive and observe each CoForge feature when verifying a change
in the running product. Used by the [`coforge-verify`](../SKILL.md) skill.
Each `##` heading written as a slug (for example `agent-dm`) is one entry,
and that slug names its artifact directory `.amp/e2e/<slug>/`.

## Topics

| File | Entries |
| --- | --- |
| [sign-in-and-workspaces.md](sign-in-and-workspaces.md) | `sign-in`, `workspace-switch`, `workspace-join`, `device-approval` |
| [conversations.md](conversations.md) | `send-message`, `agent-dm`, `channel-create`, `channel-settings`, `thread`, `mention-agent` |
| [attachments.md](attachments.md) | `attachment-send` |
| [agents.md](agents.md) | `agent-create`, `agent-configure`, `agent-control`, `agent-error-banner`, `agent-activity-tab` |
| [activity.md](activity.md) | `activity-inbox` |
| [tasks.md](tasks.md) | `task-board`, `task-create`, `task-status-and-owner`, `agent-task-flow`, `action-card` |
| [reminders.md](reminders.md) | `reminder-schedule`, `reminders-tab` |
| [computer.md](computer.md) | `computer-setup`, `computer-lifecycle`, `workspace-crash-relaunch`, `local-computer-reload`, `computers-page` |
| [agent-runtimes.md](agent-runtimes.md) | runtime table, `agent-turn`, `grok-native`, `kiro-native`, `openrouter-live` |

Not mapped yet: Records and weekly reports, Projects, Search, Members page
beyond Agents, Settings, notifications, GitHub integration, Agent migration.
Add an entry the first time a change touches one.

## Entry format

Each entry gives, as far as the code supports it:

- **Reach**: URL path (with the `/en` locale prefix for pages), UI path, or
  command.
- **Drive**: the controls, by accessible name, role, `aria-label`, `data-*`
  attribute or `name` exactly as the source defines them. The Web has almost
  no `data-testid`; do not invent one. English strings live in
  `apps/web/messages/en/*.json`.
- **Success**: what to observe, including persistence after reload.
- **Traps**: known environment faults and misleading signals.
- **Covered by**: the automated test that exercises it, its prerequisites and
  artifact, or "none found".

Write only what you confirmed in the source or in a run, and name the file it
comes from. Mark anything else "unverified". Selectors quoted from an older
test are not facts until checked against the current source.

## Environments

### Local Web

- Dev server with HMR: `./scripts/dev-web-hmr.sh` serves
  `http://127.0.0.1:8788`. With `COFORGE_DEV_SKIP_AUTH=1` in `apps/web/.env`
  every request is the dev user; seed it with `bun run seed:dev` from
  `apps/web` (full demo data) or `apps/web/scripts/seed-dev-data.ts` (user and
  Workspace only) (`apps/web/README.md`).
- Compiled servers: `./scripts/build-prod.sh`, then `./scripts/start-web.sh`
  (8788) or `./scripts/start-server.sh` (8789). The managed E2E stack publishes
  Web on 8789.
- Sending messages needs Redis (`REDIS_URL`, the message-request idempotency
  store) and live updates need Centrifugo; both come from the local Compose
  services (`infra/README.md`). A realtime check also needs the Centrifugo
  JWKS and `HOST=0.0.0.0` settings in the
  [testing guidance](../../../../docs/agents/testing.md#browser-end-to-end-tests).
- Never build into the output directory a running server or test uses.

### Staging

- `https://staging.coforge.cn`, real Authing login through the user's browser
  session. It runs the build an operator last dispatched from `main`
  ([Main to staging](../../../../docs/release/main-to-staging.md)), so it can
  verify a change only after that deployment.
- Use a disposable Workspace or conversation; do not change others' data.

### Native Computer

- Linux/systemd in a disposable OS user or the `coforge-linux` orb, local HTTPS
  through Caddy with its CA trusted
  ([Native Linux setup](../../../../docs/agents/e2e-testing/native-linux-setup.md)).
  macOS and Windows have no harness.
