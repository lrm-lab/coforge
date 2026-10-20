# Known issues and the C4 tag/filter round-trip

Part of [OpenViking prototype runtime operations](README.md).

## Known issues (OpenViking `e44ea6e` alpha)

These are upstream behaviors observed on the pinned alpha. They are not
CoForge product defects and they do not authorize an OpenViking source patch.

1. **Typed account DELETE returns 202, registry settle is unreliable.**
   `DELETE /api/v1/admin/accounts/{account_id}` is accepted, but the account
   may remain listed for a long time. Cleanup asserts that DELETE was
   accepted. A later `gone` observation is logged only.
2. **Account delete has crashed the process once.** After a typed delete the
   container restarted (`restart: unless-stopped`). Smoke and V1.4 treat
   that as an upstream risk: wait for health again if the process bounced;
   do not require a settled empty account list.
3. **`GET /api/v1/fs/attrs` does not echo `k=v` tags.** V1.4 verdict:
   retrieval depends on `POST /api/v1/search/find` `tags` / equivalent
   `filter`. Attrs-based scenes (recorded before Causal Memory removal) use a stable URI plus caller-side
   binding. Do not assert `attrs.tags` for fact id / version / generation.

## C4 tag / filter round-trip (V1.4 verdict)

C4 deferred this check to I1/V1.4. **V1.4 closed it** on the pinned
`e44ea6e` + local-embed runtime:

> `find()` tags and the equivalent metadata `filter` round-trip fact id /
> version / generation exactly. `GET /fs/attrs` does not echo those tags.
> V1 retrieval may rely on `find` tags/filter. Attrs-based binding must use
> stable URI + caller-side binding.

Provisional tag keys from D3 (final names belong to C3 / V1.1):

| Tag            | Meaning                                                             |
| -------------- | ------------------------------------------------------------------- |
| `cm_fact=<id>` | canonical Fact Document id                                          |
| `cm_ver=<n>`   | canonical fact version (integer ≥ 1)                                |
| `cm_gen=<n>`   | Fact Index projection generation (not Workspace profile generation) |

OpenViking normalizes tags with `.strip().lower()` and requires strict `k=v`.
Use lowercase ids and decimal versions. Do not store these identifiers only in
YAML frontmatter — unknown metadata is silently dropped.

V1.4 must load credentials from the mounted secret file **in-process**. Do not
put keys on `curl` argv, in fixtures, or in logs. The HTTP shapes below use
placeholders only.

### A. Filesystem tag write (do not use attrs for tags)

1. Write (or `set_tags`) the synthetic L2 document with
   `["cm_fact=fact-synth-1","cm_ver=3","cm_gen=7"]` and `tag_mode=replace`.
2. Do **not** require `GET /api/v1/fs/attrs` to echo those tags. On
   `e44ea6e` it does not.
3. `GET /api/v1/fs/ls?uri=<parent>&tags=cm_fact=fact-synth-1&tags=cm_ver=3&tags=cm_gen=7`
   (AND) may list the document; treat ls as supporting evidence, not the
   retrieval contract.

Pass criteria for V1: do not depend on attrs echo. Retrieval contract is
section B. Attrs scenes bind by stable URI + Causal Memory-side records.

### B. `find()` tags and equivalent `filter`

Deterministic causal recall uses `POST /api/v1/search/find` only — never
`POST /api/v1/search/search` (default `query_expansion=auto`) and never
`recall`. Requires `/ready` embedding + a completed vector upsert.

```http
POST /api/v1/search/find
Content-Type: application/json
```

Tags form (AND):

```json
{
  "query": "synthetic fact document",
  "target_uri": "viking://resources/cm-projection/synth-i1/",
  "limit": 10,
  "level": "2",
  "tags": ["cm_fact=fact-synth-1", "cm_ver=3", "cm_gen=7"]
}
```

Equivalent metadata `filter` (source `openviking/utils/tags.py`
`build_search_tags_filter`, revision `e44ea6e11add1c7b3d4accdbfaf16e900a6049df`):

```json
{
  "query": "synthetic fact document",
  "target_uri": "viking://resources/cm-projection/synth-i1/",
  "limit": 10,
  "level": "2",
  "filter": {
    "op": "and",
    "conds": [
      { "op": "must", "field": "search_tags", "conds": ["cm_fact=fact-synth-1"] },
      { "op": "must", "field": "search_tags", "conds": ["cm_ver=3"] },
      { "op": "must", "field": "search_tags", "conds": ["cm_gen=7"] }
    ]
  }
}
```

Pass criteria:

1. Both requests return the same synthetic URI and no foreign-account document.
2. Repeating the tags request with `cm_gen=8` or `cm_ver=2` returns zero hits
   for that document (stale generation / stale version rejected at retrieval).
3. `target_uri` stays inside the managed subtree; a second synthetic account
   must not see `fact-synth-1`.
4. Do not send `session_id`, `query_expansion`, or `image_url`.
5. Always delete the disposable account/document afterwards.

V1.4 ran B against local-embed on the non-internal loopback publish and
recorded a pass for tags + equivalent filter + stale rejection. Do not open
a public route. Do not reintroduce `internal: true` to “fix” egress — models
are host-mounted. If embedding is not ready (warmup or missing weights),
record that as an environment gap; fallback remains stable URI + Causal
Memory-side binding.
