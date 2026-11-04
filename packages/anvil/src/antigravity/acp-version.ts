import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { cliVersionGate } from "#src/version-gate";

/**
 * The `agy` floor for the ACP launch contract: `agy acp` — the stdio ACP server — first ships in
 * agy 1.5.0 (official Antigravity CLI docs), where `initialize` also declares
 * `_meta.antigravity.systemPrompt.append`, the standing-instructions channel launches depend on.
 * Below it there is no ACP server to start; the gate refuses with the shared upgrade message so
 * the Computer page can point at 1.5.0. Verified live on agy 1.5.0.
 */
export const ANTIGRAVITY_ACP_MIN_VERSION = "1.5.0";

const gate = cliVersionGate({
  provider: RUNTIME_PROVIDER.ANTIGRAVITY,
  label: "Antigravity CLI",
  executable: "agy",
  minimum: ANTIGRAVITY_ACP_MIN_VERSION,
});

export const isAntigravityAcpVersionUnsupported = gate.isUnsupported;
export const logAntigravityAcpVersionUnsupported = gate.logUnsupported;
export const assertAntigravityAcpVersionSupported = gate.assertSupported;
