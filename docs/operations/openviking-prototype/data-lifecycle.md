# Synthetic seed, cleanup, backup, and restore

Part of [OpenViking prototype runtime operations](README.md).

## Synthetic seed and cleanup

Only synthetic documents are allowed. Suggested disposable objects:

| Object                  | Synthetic value                                                   |
| ----------------------- | ----------------------------------------------------------------- |
| OpenViking account      | `synth-i1`                                                        |
| Admin / projection user | `synth-admin` / `synth-projector`                                 |
| Managed subtree         | `viking://resources/cm-projection/synth-i1/`                      |
| Fact document           | `viking://resources/cm-projection/synth-i1/facts/fact-synth-1.md` |

Seed (data-plane user or admin key, loaded in-process):

1. `POST /api/v1/fs/mkdir` for the managed subtree if needed.
2. `POST /api/v1/content/write` with synthetic markdown body, `wait=true` when
   an embedding backend can complete vector upsert, and tags
   `cm_fact=fact-synth-1`, `cm_ver=3`, `cm_gen=7`.
3. If vector upsert is unavailable, `POST /api/v1/content/set_tags` (or
   `POST /api/v1/fs/attrs/set_tags`) still records explicit `k=v` tags for
   the filesystem half of the C4 check.

Cleanup — always run, including after a failed seed:

1. `DELETE /api/v1/fs` on the synthetic document / subtree, **or**
2. typed `DELETE /api/v1/admin/accounts/synth-i1` (official account-deletion
   primitive; HTTP 202 in the pinned source). Prefer account deletion when the
   whole disposable account was created for the test.
3. Treat the accepted DELETE as cleanup success. Do **not** require the
   account to disappear from `GET /api/v1/admin/accounts` — the pinned alpha
   registry settle is unreliable (see Known issues).
4. Do not leave seed documents for the next run. V1.4 / F6 must clean up in
   `finally`.

Never seed from PublicChannel production transcripts. Never commit ovpack
archives or volume tarballs.

## Backup, restore, and reindex

The volume `coforge_openviking_prototype_data` is the prototype data boundary.
Treat it as synthetic-only. Backup is an external host job, not a Web request,
Agent action, or container startup hook.

Application-consistent volume snapshot:

1. Stop `openviking-prototype` and wait until it is not running. Local VectorDB
   uses a workspace lock; do not copy `/data` while the writer is live.
2. Capture the complete volume. Encrypt at the backup boundary. Record image
   digest, OpenViking revision, volume name, UTC timestamps, and checksum —
   never document bodies or keys.
3. Restart the same service and require `GET /health` before ending the window.

Official online pack (not an atomic snapshot; pause writes if you need
consistency):

- Backup: `POST /api/v1/pack/backup` as ROOT/ADMIN. Response is an `.ovpack`
  zip. It does not include user accounts or API keys.
- Restore: upload via `POST /api/v1/resources/temp_upload`, then
  `POST /api/v1/pack/restore`. OVPack restore does not recreate accounts; create
  the same `user_id` values and **new** keys on the target.
- Workspace snapshots (`/api/v1/snapshot/*`) are a second official tool; they
  are not a substitute for an encrypted volume snapshot.

Reindex after restore, embedding-model change, or a failed vector upsert:

```http
POST /api/v1/content/reindex
```

Body: `{ "uri": "viking://resources/cm-projection/synth-i1", "mode": "vectors_only", "wait": true }`.
There is no `/api/v1/maintenance/reindex`. Passing `tags` during reindex writes
those tags onto successfully rebuilt vector records; omit `tags` to keep
existing ones. After reindex, re-run the C4 tag/filter check below.

Restore cutover: preserve the failed volume read-only, restore into a fresh
volume, start one replacement container on the private `openviking` network,
require `/health`, then run the synthetic isolation check (two disposable
accounts must not read each other's documents). There is no public-endpoint
cutover.
