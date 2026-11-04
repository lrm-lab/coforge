import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { cliVersionGate } from "#src/version-gate";

/**
 * The OpenCode CLI floor for the ACP launch contract, verified end to end on 2.1.0: `opencode
 * acp` advertises `loadSession`, `session/new`/`session/load` return the `model` config select
 * with `provider/model` values and the `thought_level` effort select after a model applies,
 * `session/load` answers `-32602 "session not found"` for a missing id, and a second in-flight
 * `session/prompt` is refused with `-32603`.
 *
 * The instructions channel would allow 2.0.30 (the first release whose instruction plugin
 * loads absolute `instructions` entries from `OPENCODE_CONFIG_CONTENT`), but the ACP surface
 * above is unverified between 2.0.30 and 2.1.0 — the floor is the verified version, not the
 * earlier instructions-only one.
 */
export const OPENCODE_ACP_MIN_VERSION = "2.1.0";

const gate = cliVersionGate({
  provider: RUNTIME_PROVIDER.OPENCODE,
  label: "OpenCode",
  executable: RUNTIME_PROVIDER.OPENCODE,
  minimum: OPENCODE_ACP_MIN_VERSION,
});

export const isOpenCodeAcpVersionUnsupported = gate.isUnsupported;
export const logOpenCodeAcpVersionUnsupported = gate.logUnsupported;
export const assertOpenCodeAcpVersionSupported = gate.assertSupported;
