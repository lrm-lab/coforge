import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { cliVersionGate } from "#src/version-gate";

/**
 * `cmd acp` ignores `--mod` before CLI 1.87.2, so the standing instructions would never arrive.
 * `cmd --version` prints the version alone, which the gate's last-token parse reads.
 * A version that is not dotted numbers is never gated.
 */
export const COMMAND_CODE_MIN_CLI_VERSION = "1.87.2";

const gate = cliVersionGate({
  provider: RUNTIME_PROVIDER.COMMAND_CODE,
  label: "Command Code",
  executable: "cmd",
  minimum: COMMAND_CODE_MIN_CLI_VERSION,
});

export const isCommandCodeVersionUnsupported = gate.isUnsupported;
export const logCommandCodeVersionUnsupported = gate.logUnsupported;
export const assertCommandCodeVersionSupported = gate.assertSupported;
