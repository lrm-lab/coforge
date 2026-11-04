import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { cliVersionGate } from "#src/version-gate";

/**
 * The Cursor CLI floor for the ACP launch contract, verified end to end on
 * 2026.10.22-27dcf5f: `cursor-agent acp` advertises `loadSession`, `session/new` and
 * `session/load` return `models` plus the `mode`/`model` config selects, `session/load`
 * replays the stored conversation and answers `-32602` for a missing id, a second in-flight
 * `session/prompt` steers into the live turn, and `session/cancel` is `-32601`.
 */
export const CURSOR_ACP_MIN_VERSION = "2026.10.22";

const gate = cliVersionGate({
  provider: RUNTIME_PROVIDER.CURSOR,
  label: "Cursor",
  executable: "cursor-agent",
  minimum: CURSOR_ACP_MIN_VERSION,
});

export const isCursorAcpVersionUnsupported = gate.isUnsupported;
export const logCursorAcpVersionUnsupported = gate.logUnsupported;
export const assertCursorAcpVersionSupported = gate.assertSupported;
