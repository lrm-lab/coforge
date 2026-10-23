# App bots

An app's bot (`apps/web/src/server/app-bots/`, [App Bot](../app-bot/README.md)). Migration
`20261024160000_app_bot`; models in `apps/web/prisma/models/app-bots.prisma`.

`apps` gains `enableBot` (BOOLEAN NOT NULL DEFAULT false): the app declares a bot. See
[the app registry](apps.md).

## `app_installation_bots`

One row per installation with a bot, made by its first grant and kept by later ones.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID | v7 primary key. |
| `installationId` | UUID | Unique; references `app_installations` (cascade). |
| `agentId` | UUID | Unique; references `agents` (cascade). The bot's Agent, `systemKind = app-bot`. |
| `state` | TEXT | `granted` or `revoked` (`app_installation_bots_state_check`). |
| `generation` | INTEGER | Starts at 1, goes up at every grant after a revoke (or after the Agent was archived under a standing grant). A key belongs to one generation. |
| `statusText` | TEXT | The app's status line, never empty, null unless `granted` (`app_installation_bots_status_check`). The 160-unit limit is the application's. |
| `grantedByUserId` | UUID | References `users` (set null). |
| `grantedAt`, `revokedAt` | TIMESTAMP | The latest grant; the latest revoke, null while granted. |
| `createdAt`, `updatedAt` | TIMESTAMP | |

The bot Agent has no Computer, so `agents.computerId` is null, and the `runtimeConfig` is an inert
placeholder. Revoking archives it (`agents.deletedAt`, `deletedByUserId`); granting again clears
both. An uninstall archives the Agent in the same transaction that deletes the installation, which
cascades this row away; the next installation's first grant adopts that Agent by its handle.

## `app_bot_credentials`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID | v7 primary key; the `credentialId` the app is given. |
| `botId` | UUID | References `app_installation_bots` (cascade). |
| `keyHash` | TEXT | Unique; SHA-256 of the key. The key is never stored. |
| `generation` | INTEGER | The bot's `generation` when it was minted; valid only while equal. |
| `createdAt`, `revokedAt` | TIMESTAMP | Revoked by a rotate, a revoke, or `enableBot` off. |

A partial unique index, `app_bot_credentials_one_live` on (`botId`) where `revokedAt IS NULL`, keeps
one live key per bot. A key authenticates only while its row is live, its generation is the bot's,
the bot is `granted`, the Agent is not archived and the app still declares `enableBot`.

All writes of one installation lock its `app_installations` row (`FOR UPDATE`), so grants, revokes,
keys and status lines run one at a time.
