import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { cliVersionGate } from "#src/version-gate";

export const ANTIGRAVITY_ACP_MIN_VERSION = "1.5.8";

const gate = cliVersionGate({
  provider: RUNTIME_PROVIDER.ANTIGRAVITY,
  label: "Antigravity CLI",
  executable: "agy",
  minimum: ANTIGRAVITY_ACP_MIN_VERSION,
});

export const isAntigravityAcpVersionUnsupported = gate.isUnsupported;
export const logAntigravityAcpVersionUnsupported = gate.logUnsupported;
export const assertAntigravityAcpVersionSupported = gate.assertSupported;
