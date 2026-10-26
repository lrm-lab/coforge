# DeepSeek Harness ACP

The DSH adapter lives in `packages/anvil/src/dsh/` and is exported through
`@lrm/coforge-anvil/dsh`. The daemon owns its environment, process tree and private
launch files. Adding the adapter does not advertise DSH to Computers or add it to
the runtime picker; those switches require native acceptance and UI review.
`runtime-provider-selection.ts` also rejects DSH at both create/edit service
entries and their shared input schema, so direct API calls cannot bypass rollout.

## Compatibility and installation

The verified preview is **`@deepseek-ai/dsh@0.2.1-rc.2`**. Install it separately and
make `dsh` available on the Computer's PATH. CoForge never invokes npx or installs
DSH/plugins on the user's behalf. DSH's own first profile startup can prepare its
plugin dependencies and require network access; the measured cold start was
about 65 seconds. Startup/config/cancellation exchanges have a 120-second default
budget. Prompt admission and full turns have no adapter deadline.

The adapter checks `dsh --version` before every launch. Only the exact verified
preview is accepted; unknown, unreadable, older and newer versions fail closed.
The shared minimum-version comparator is unchanged. Upgrade the pin only after
fixture checks and native acceptance of that release.

## Instructions and environment

Launch uses `dsh --profile acp --patch <private path>` in the Agent's declared
workspace. The invocation overlay does not write the user's profile or rule files.
The host materializes a static, dependency-free `.mjs` plugin and JSON-encoded
YAML patch in one temporary directory: directory mode 0700, file modes 0600.
Instructions are a config string, not executable JS. The plugin registers one
`coforge:instructions` section with `interpolate:false`, preserving literal
`{{...}}`, Unicode and newlines. The invocation clears `personaPrefix`, so CoForge
instructions supply the Agent's persona while DSH's harness/tool guidance stays.
Invalid instruction configuration fails startup explicitly.

Process exit, startup failure, interrupt and terminal dispose clean the launch
files. The host owns file creation and deletion; Anvil only constructs content
and requests cleanup through its port. Cleanup is idempotent. Interrupt may keep
the already configured ACP process alive; that profile has no live reload and
does not need its launch files again.

Credentials stay in the native environment/profile. Never put API keys in argv,
plugin source or the patch. Discovery and real sessions must read the same
DSH_HOME/profile/account; probing must not silently substitute an isolated home.

## Native sessions and delivery

DSH uses `initialize`, `session/new`, `session/resume`, `session/set_config_option`,
`session/prompt`, `session/cancel` and `session/close`. It does not implement
`session/load`. A failed resume is not silently replaced. Model selection values
are opaque native tokens, including JSON-encoded route/model pairs; preserve
them exactly. Reasoning comes from native `reasoning_effort` choices.

One ACP process persists across turns. There is one native prompt in flight.
Busy input queues locally, with its notification promise pending until native
acceptance. An assistant/tool update or non-cancelled terminal RPC response
settles the adapter's acceptance accounting. Writing stdin alone is not an ACK. A silent successful turn
still confirms acceptance. Cancelled input does not gain a successful ACK.

After a prompt settles, the adapter submits the next queued input. Interrupt
first rejects queued input, sends `session/cancel`, and waits boundedly for the
prompt's native `cancelled` settlement. Dispose begins process-tree termination
immediately; it never waits for a natural turn end.

Only a local failure before submission is a known rejection. After submission,
any terminal JSON-RPC error is an accepted, failed turn; preserve its native
message/data detail and code after redaction. This is the reviewed delivery
accounting policy, not proof that every native error occurs after DSH queued the
message. A transport loss has an **unknown**
outcome: DSH may already have persisted
the user message. The adapter rejects the wait without retrying or emitting
`notice-undelivered`; replaying automatically on resume could duplicate input.

## Permissions, tools and attachments

The reviewed host policy follows the existing autonomous Computer runtimes:
`DSH_PERMISSION_MODE=danger-full-access`, matching Codex's sandbox policy. A
request for the current active session selects `allow_once` when offered;
requests outside that session or while stopping are cancelled. Do not reinterpret
this as a separate interactive permission flow.

Disable `tool-plugin-manager`/`plugin-manager` and `plan-mode`: the former permits
runtime plugin installation, and the latter's `exit_plan_mode` needs interactive
approval. Preserve native subagent, workflow and goal capabilities. Native
acceptance must actually exercise each before user exposure; a model request's
tool list alone does not prove they finish without interaction.

The pinned ACP profile advertises `promptCapabilities.image=false`. CoForge
sends text prompts; attachment retrieval remains through the Agent CLI. Do not
embed image prompt blocks. Native tools such as `read_image` remain native tools.
Only official ACP assistant/tool updates become Activity. Tool titles in this
preview are native tool names. Shell reply-intent recognition stays a host policy.

## Catalog discovery and acceptance

`session/new` returns the model/reasoning directory, so discovery must create a
native session, read config options, then close it and stop the probe process.
Closing leaves a persisted empty session; the pinned ACP and JSONL persistence
backend provide no deletion API. The daemon removes its temporary cwd, never the
native session files, and retains the real home/profile/account. After the separate rollout opens, discovery runs
in the background after daemon readiness. Its successful model metadata is cached
only within the process, keyed by installation/configuration file stats and the
effective environment. Relative DSH_HOME resolves against the inventory probe cwd
(the daemon cwd by default), before launching in the temporary directory. Credential files are stat'd without reading their contents.
The environment fingerprint stays in memory, so a disk catalog cannot be validated
after restart and is never trusted. There is no periodic DSH refresh; a new
process, changed inputs or explicit refresh creates another native session.
Concurrent discovery shares one in-flight operation, including initial profile
preparation and cleanup. Ordinary waiters re-check their latest inputs afterward;
explicit refresh requests are serialized and still each perform a new probe.
Explicit refresh failures report an error and preserve the previous cache.
Tracked files are the executable, home patch,
`.credentials.yaml`, home `.env`, and ACP profile patch/package/lock files.
The profile's presence is checked; directory timestamps and the generated
`cordis.yml` (rewritten by native boot) do not invalidate model metadata.
Custom plugins or credential-store paths outside those roots require explicit refresh.
Anvil owns the native exchange and parsing; the daemon owns this cache and cwd.

ACP advertises no authentication methods; its authenticate method is a no-op.
For account authentication, log in through native `dsh web` using the same DSH_HOME;
ACP can reuse its stored grant. API keys use native credential resolution: stored
file, launch environment, project `.env`, then harness-home `.env`. Catalog probes
use their temporary project directory, so agent-specific project `.env` files are
not a source for the Computer-wide catalog. Account and API-key routes are separate;
neither falls back to the other. A listed model is configuration metadata, not proof
of a valid login, balance or successful model request.

The local fake model endpoint verified exact instruction content, including
nested braces and a 115,041-byte sample; it intentionally refused generation.
That proves serialization, not actual model completion or an unlimited size.
The ACP fixture covers queue order, cancellation, permissions, native terminal errors,
unknown delivery outcome, resume and cleanup. Native model generation,
subagent/workflow/goal completion, account behavior and UI screenshots remain
the final acceptance slice before enabling discovery/picker switches.

## Sources

The implementation was checked against the published
[DSH 0.2.1-rc.2 package](https://www.npmjs.com/package/@deepseek-ai/dsh/v/0.2.1-rc.2)
and that installation's `dsh-system-prompt`, `dsh-acp`, `dsh-app-boot`,
`dsh-skill-filesystem` and `dsh-llm-deepseek-api-key` package documentation/source.
The [official repository](https://github.com/deepseek-ai/deepseek-harness) owns
those native protocols and config formats; the installed preview is the
compatibility baseline, rather than an unpinned later revision.
