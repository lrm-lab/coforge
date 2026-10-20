# Known gaps and recommended binding (sections 7–8)

Part of [OpenViking prototype public-runtime interface inventory](README.md).

## 7. Known gaps and architecture conflicts

Return these to `#coforge`; do not silently turn them into code.

1. **Official overview is not the complete mount table.** Source additionally mounts MCP, OAuth JSON helpers, `/api/v1/debug/*`, `/api/v1/console/*`, `/api/v1/stats/*`, `/api/v1/user-settings/*`, and hidden `/api/v1/admin/.../bot/*`. Unsupported or newly introduced routes still remain denied at the gateway until classified.
2. **No OpenViking watermark field.** Causal watermark-plus-local-delta cannot be implemented as an upstream query parameter; it stays a Causal Memory merge after `find()`.
3. **L0/L1 generation is asynchronous and sampled.** Official freshness rules (`docs/zh/concepts/03-context-layers.md`) allow parent abstracts to lag. That matches eventually-consistent projection, not a second source of truth.
4. **Unknown metadata is dropped.** Stable adapter identifiers must use documented tags/`filter`, not unofficial frontmatter.
5. **`search()` defaults are unsafe for causal recall.** `query_expansion="auto"` and optional `session_id` would break deterministic candidate retrieval if used as the Fact Index path. `find()` is sufficient without an OpenViking patch.
6. **Trusted-mode auto-registration** can create users as a side effect. CoForge typed provisioning should remain the account/user authority.
7. **Alpha + AGPL.** Runtime is explicitly Alpha and AGPL-3.0. This reinforces the prototype/license gate.
8. **CollectionAdapter exists; LanceDB does not need a CoForge seam.**
9. **Account/user model aligns with CoForge's mapping** (one Workspace → one account; humans/Agents → users; projection worker → restricted identity). Directory naming is not isolation.
10. **No OpenViking source change is required** for: complete authorized access through a gateway, tag-backed fact identifiers, and deterministic `find()` against a managed subtree. A patch would only become necessary if later conformance proved tags/`filter` cannot round-trip fact id + version, or if `find()` cannot stay inside a namespace without leaking other account content.

## 8. Recommended prototype binding (non-normative)

This section is implementation guidance for later stages, not architecture.

- Run OpenViking in `trusted` mode behind the CoForge gateway, or in `api_key` mode with only server-owned user keys. Strip inbound identity headers in either case.
- Provision one account per Workspace through typed admin APIs.
- Causal Fact Index: `content/write` + tags into the managed subtree; `search/find` with `target_uri` + `limit≤10`; never `sessions/*/commit` or `extract` for managed facts.
- Cleanup: typed `DELETE /api/v1/admin/accounts/{account_id}`, not a recursive public `DELETE /api/v1/fs` from a generic proxy.

Pin for all downstream Stage 2+ work: **OpenViking `e44ea6e11add1c7b3d4accdbfaf16e900a6049df`**.
