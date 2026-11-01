# Records server

Records rules live in [`../../features/records/AGENTS.md`](../../features/records/AGENTS.md).

- `record-catalog-access.server.ts` owns shared Workspace membership checks for Records use cases.
- `record-catalog-stats.server.ts` owns statistics, dashboard, and weekly-report exports.
- `record-catalog-format.server.ts` owns weekly-report cycles and live format document alignment.
- `record-catalog-templates.server.ts` owns template settings, key-point prompts, and template CRUD.
- `record-side-chat.server.ts` owns Records side-chat intents and platform comment read/write operations.
- `record-distribution.server.ts` owns weekly send-window state, manual distribution, and scheduled sends.
- `record-assistant-catalog.server.ts` owns Assistant format/report listings and personal note writes.
- `record-key-point-edits.server.ts` owns confirmed and dismissed key-point markdown writes.
