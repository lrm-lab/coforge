import { RUNTIME_PROVIDER, type RuntimeMetadata } from "@lrm/coforge-sdk/internal";
import {
  isOpenCodeAcpVersionUnsupported,
  logOpenCodeAcpVersionUnsupported,
} from "@lrm/coforge-anvil/opencode";
import {
  isCursorAcpVersionUnsupported,
  logCursorAcpVersionUnsupported,
} from "@lrm/coforge-anvil/cursor";
import { isKiroVersionUnsupported, logKiroVersionUnsupported } from "@lrm/coforge-anvil/kiro";
import { isGrokVersionUnsupported, logGrokVersionUnsupported } from "@lrm/coforge-anvil/grok";
import {
  isCommandCodeVersionUnsupported,
  logCommandCodeVersionUnsupported,
} from "@lrm/coforge-anvil/command-code";
import { isDevinVersionUnsupported, logDevinVersionUnsupported } from "@lrm/coforge-anvil/devin";
import {
  isAntigravityAcpVersionUnsupported,
  logAntigravityAcpVersionUnsupported,
} from "@lrm/coforge-anvil/antigravity";
import {
  isDroidAcpVersionUnsupported,
  logDroidAcpVersionUnsupported,
} from "@lrm/coforge-anvil/droid";
import type { ExternalCodeAgentProvider } from "./runtime-executable";

/** One provider's launch floor: the comparison its adapter exports, and the warning it logs. */
type VersionGate = {
  unsupported(version: string): boolean;
  log(name: string, version: string): void;
};

/** Provider version floors the probe and the cached-floor check share. */
const VERSION_GATES = new Map<ExternalCodeAgentProvider, VersionGate>([
  [
    RUNTIME_PROVIDER.KIRO,
    { unsupported: isKiroVersionUnsupported, log: logKiroVersionUnsupported },
  ],
  [
    RUNTIME_PROVIDER.OPENCODE,
    { unsupported: isOpenCodeAcpVersionUnsupported, log: logOpenCodeAcpVersionUnsupported },
  ],
  [
    RUNTIME_PROVIDER.CURSOR,
    { unsupported: isCursorAcpVersionUnsupported, log: logCursorAcpVersionUnsupported },
  ],
  [
    RUNTIME_PROVIDER.GROK,
    { unsupported: isGrokVersionUnsupported, log: logGrokVersionUnsupported },
  ],
  [
    RUNTIME_PROVIDER.ANTIGRAVITY,
    { unsupported: isAntigravityAcpVersionUnsupported, log: logAntigravityAcpVersionUnsupported },
  ],
  [
    RUNTIME_PROVIDER.COMMAND_CODE,
    { unsupported: isCommandCodeVersionUnsupported, log: logCommandCodeVersionUnsupported },
  ],
  [
    RUNTIME_PROVIDER.DEVIN,
    { unsupported: isDevinVersionUnsupported, log: logDevinVersionUnsupported },
  ],
  [
    RUNTIME_PROVIDER.DROID,
    { unsupported: isDroidAcpVersionUnsupported, log: logDroidAcpVersionUnsupported },
  ],
]);

/** The floor a provider's installed version is judged against, or none. */
export function versionGateFor(provider: ExternalCodeAgentProvider): VersionGate | undefined {
  return VERSION_GATES.get(provider);
}

/** Providers whose cached runtime must be dropped once its version falls below the floor: an
 * older daemon cached them before the floor moved, and serving one would offer a CLI this build
 * refuses to launch. */
const CACHED_FLOOR_PROVIDERS = new Set<ExternalCodeAgentProvider>([
  RUNTIME_PROVIDER.KIRO,
  RUNTIME_PROVIDER.OPENCODE,
  RUNTIME_PROVIDER.CURSOR,
  RUNTIME_PROVIDER.COMMAND_CODE,
  RUNTIME_PROVIDER.DEVIN,
  RUNTIME_PROVIDER.DROID,
]);

export function cachedBelowFloor(
  provider: ExternalCodeAgentProvider,
  name: string,
  runtime: RuntimeMetadata | undefined,
): boolean {
  if (runtime === undefined || !CACHED_FLOOR_PROVIDERS.has(provider)) return false;
  const gate = VERSION_GATES.get(provider);
  if (!gate?.unsupported(runtime.version)) return false;
  gate.log(name, runtime.version);
  return true;
}

/** The name a person reads for an external Code Agent runtime. */
export function externalRuntimeDisplayName(provider: ExternalCodeAgentProvider): string {
  switch (provider) {
    case RUNTIME_PROVIDER.CODEX:
      return "Codex";
    case RUNTIME_PROVIDER.CLAUDE_CODE:
      return "Claude Code";
    case RUNTIME_PROVIDER.KIRO:
      return "Kiro";
    case RUNTIME_PROVIDER.CURSOR:
      return "Cursor CLI";
    case RUNTIME_PROVIDER.OPENCODE:
      return "OpenCode";
    case RUNTIME_PROVIDER.GROK:
      return "Grok Build";
    case RUNTIME_PROVIDER.ANTIGRAVITY:
      return "Antigravity CLI";
    case RUNTIME_PROVIDER.COMMAND_CODE:
      return "Command Code";
    case RUNTIME_PROVIDER.DEVIN:
      return "Devin";
    case RUNTIME_PROVIDER.DSH:
      return "DeepSeek Harness";
    case RUNTIME_PROVIDER.DROID:
      return "Droid";
    default: {
      const unreachable: never = provider;
      throw new Error(`Unhandled external Code Agent provider: ${unreachable}`);
    }
  }
}
