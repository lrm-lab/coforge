# Records server

Records rules live in [`../../features/records/AGENTS.md`](../../features/records/AGENTS.md).

- `record-catalog-access.server.ts` owns shared Workspace membership checks for Records use cases.
- `record-catalog-stats.server.ts` owns statistics, dashboard, and weekly-report exports.
- `record-catalog-format.server.ts` owns weekly-report cycles and live format document alignment.
- `record-catalog-templates.server.ts` owns template settings, key-point prompts, and template CRUD.
