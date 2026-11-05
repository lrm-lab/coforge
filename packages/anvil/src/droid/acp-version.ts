import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { cliVersionGate } from "#src/version-gate";

/**
 * The Droid CLI floor for the ACP launch contract, verified end to end on 1.4.1: `droid exec
 * --output-format acp` advertises `loadSession` with `session/list|resume|close|fork`,
 * `session/new` returns the `model` and `reasoning_effort` selects plus the `autonomy_level`
 * mode, `session/set_config_option` applies both selects, `session/load` answers `-32602
 * "Unknown session identifier"` for a missing session, and `session/cancel` is `-32601` (an
 * interrupt kills the process).
 */
export const DROID_ACP_MIN_VERSION = "1.4.1";

const gate = cliVersionGate({
  provider: RUNTIME_PROVIDER.DROID,
  label: "Droid",
  executable: RUNTIME_PROVIDER.DROID,
  minimum: DROID_ACP_MIN_VERSION,
});

export const isDroidAcpVersionUnsupported = gate.isUnsupported;
export const logDroidAcpVersionUnsupported = gate.logUnsupported;
export const assertDroidAcpVersionSupported = gate.assertSupported;
