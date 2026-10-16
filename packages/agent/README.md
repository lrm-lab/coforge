# coforge-agent

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
Repeated retrieval with no new source evidence prompts a partial cited Offer;
useful retrieval remains unlimited. Discovery tracks stable source identity rather than snippet wording; progress advice recommends document reading and Fork strategy pivots. Changed Offer payloads cannot reuse an operation ID within a live session, including across triggers. See [runtime instructions](AGENTS.md).
