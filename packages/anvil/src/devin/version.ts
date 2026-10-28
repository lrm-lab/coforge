import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { cliVersionGate } from "#src/version-gate";

/**
 * The first Devin CLI release this adapter was exercised against (`devin acp` ACP v1: session/new
 * model and thought_level selects, session/load, session/set_mode). An older release is refused
 * rather than run blindly. `devin --version` prints `devin 3000.11.228 (<build hash>)`, so the
 * version is the first dotted-numeric token, not the last word.
 */
export const DEVIN_MIN_CLI_VERSION = "3000.11.228";

/** `devin <version> (<build hash>)`: the first dotted-numeric token, not the trailing hash. */
export function devinVersionFromOutput(output: string): string | undefined {
  return output
    .trim()
    .split(/\s+/)
    .find((token) => /^\d+(?:\.\d+)+$/.test(token));
}

const gate = cliVersionGate({
  provider: RUNTIME_PROVIDER.DEVIN,
  label: "Devin CLI",
  executable: "devin",
  minimum: DEVIN_MIN_CLI_VERSION,
  versionFromOutput: devinVersionFromOutput,
});

export const isDevinVersionUnsupported = gate.isUnsupported;
export const logDevinVersionUnsupported = gate.logUnsupported;
export const assertDevinVersionSupported = gate.assertSupported;
