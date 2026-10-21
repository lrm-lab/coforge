# coforge-agent

`src/pi-chat/` owns standalone cloud Pi sessions: native SDK execution, complete
transcript reads, session metadata, request deduplication, and the internal JSONL worker.

`@coforge/agent` is CoForge's built-in code-agent runtime. It is hosted by
`coforge-daemon` in the daemon process (the package also exposes a standalone
RPC runner for packaging and tests) and currently uses the official Pi SDK.

The package owns Pi-specific SDK setup, extensions, and skills. It is bundled
with the Daemon release and is not installed directly by users.

The package can be packed and installed independently:

```bash
bun run check
mise run test:file
bun run pack:check
```

Installing it provides the `coforge-agent` executable. The runner finishes Pi
resource discovery, including `.agents/skills` from its working directory and
ancestors, before accepting JSONL commands on stdin.

Local evaluation can set `COFORGE_LLM_POOL_URL` to route Lenovo model requests
through the shared Gemma request pool. Session authentication is preserved and
`COFORGE_EVAL_LLM_CLIENT` labels credential-free request auditing. The evaluation
Docker Task relay uses the same pool; see the SWE Gemma ops README.

Channel turns settle normally after repeated empty CLI polling or a published
Memory Offer or completed diagnosis report. The Pi finish hook leaves queued and later input resumable.
Channel question/answer evaluations can set `COFORGE_EVAL_SETTLE_SENDS=1` to end a
model turn after a successful CLI channel-send receipt. New inbox input can still
resume it; failed sends and unaccepted drafts do not settle. This is disabled by
default and does not inspect answer text, shorten the episode timeout or change scoring.
Repeated retrieval with no new source evidence prompts a partial cited Offer;
useful retrieval remains unlimited. Discovery tracks stable source identity rather than snippet wording.
New discovery IDs do not clear the separate search-without-reading warning, which persists across
Task follow-ups until a new factual document body is read. Progress advice includes a returned
document URI, constraint verification and counterevidence; it does not force the first hit or cap reads.
Documentary `ov_search_context` discovery excerpts are presented at up to 480 characters; repeated identical
snippets are omitted with a separate discovery note. Citation identity, version and graph metadata
stay intact, Fork discovery is unchanged, and `ov_read` still returns the full document. Missing
details in a discovery card must not be treated as absent from its source. Later progress reminders
are compact rather than repeating the full strategy instructions on every search.
Changed Offer payloads cannot reuse an operation ID within a live session, including across triggers. See [runtime instructions](AGENTS.md).

Documentary queries use `ov_search_context` (embedding recall and native context assembly).
Method/experience queries use `ov_fork_find`, fixed to the causal Fork namespace; follow
served relations with `ov_expand`. `ov_find` is not exposed to fenced agents.
