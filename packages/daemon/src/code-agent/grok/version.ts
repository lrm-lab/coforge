import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { cliVersionGate } from "#src/code-agent/version-gate";

/** Persistent ACP baseline, verified against the official 1.0.62 binary with a local model.
 * Native queue admission, interjection fallback and durable turn completion are required;
 * earlier per-turn releases are not assumed to implement these session lifecycle semantics. */
export const GROK_MIN_CLI_VERSION = "1.0.62";

const gate = cliVersionGate({
  provider: RUNTIME_PROVIDER.GROK,
  label: "Grok Build",
  executable: "grok",
  minimum: GROK_MIN_CLI_VERSION,
  // Grok prints `grok 1.0.41 (4220f3b224a6)` — the version is the token that parses as dotted
  // numbers, not the last word (the build hash is not a version).
  versionFromOutput: (output) =>
    output
      .trim()
      .split(/\s+/)
      .find((token) => /^\d+(\.\d+)*$/.test(token)),
});

export const isGrokVersionUnsupported = gate.isUnsupported;
export const logGrokVersionUnsupported = gate.logUnsupported;
export const readGrokVersion = gate.readVersion;
export const assertGrokVersionSupported = gate.assertSupported;
