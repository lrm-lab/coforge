import {
  parseRuntimeProvider,
  RUNTIME_PROVIDER,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import { m } from "#src/paraglide/messages";

export const RUNTIME_PROVIDER_DISPLAY_ORDER: readonly RuntimeProvider[] = [
  RUNTIME_PROVIDER.ANTIGRAVITY,
  RUNTIME_PROVIDER.CLAUDE_CODE,
  RUNTIME_PROVIDER.CODEX,
  RUNTIME_PROVIDER.COMMAND_CODE,
  RUNTIME_PROVIDER.CURSOR,
  RUNTIME_PROVIDER.DSH,
  RUNTIME_PROVIDER.DEVIN,
  RUNTIME_PROVIDER.DROID,
  RUNTIME_PROVIDER.GROK,
  RUNTIME_PROVIDER.KIRO,
  RUNTIME_PROVIDER.OPENCODE,
  RUNTIME_PROVIDER.PI,
];

const EXTERNAL_RUNTIME_PROVIDER_LABELS: Record<
  Exclude<RuntimeProvider, typeof RUNTIME_PROVIDER.COFORGE>,
  string
> = {
  [RUNTIME_PROVIDER.PI]: "Pi",
  [RUNTIME_PROVIDER.CODEX]: "Codex",
  [RUNTIME_PROVIDER.CLAUDE_CODE]: "Claude Code",
  [RUNTIME_PROVIDER.KIRO]: "Kiro",
  [RUNTIME_PROVIDER.CURSOR]: "Cursor CLI",
  [RUNTIME_PROVIDER.OPENCODE]: "OpenCode",
  [RUNTIME_PROVIDER.GROK]: "Grok Build",
  [RUNTIME_PROVIDER.ANTIGRAVITY]: "Antigravity CLI",
  [RUNTIME_PROVIDER.DSH]: "DeepSeek Harness",
  [RUNTIME_PROVIDER.COMMAND_CODE]: "Command Code",
  [RUNTIME_PROVIDER.DEVIN]: "Devin",
  [RUNTIME_PROVIDER.DROID]: "Droid",
};

export function runtimeProviderLabel(provider: RuntimeProvider): string {
  if (provider === RUNTIME_PROVIDER.COFORGE) return m.agent_provider_pi_builtin();
  return EXTERNAL_RUNTIME_PROVIDER_LABELS[provider];
}

export function runtimeProviderDisplayName(provider: string): string {
  const parsed = parseRuntimeProvider(provider);
  return parsed ? runtimeProviderLabel(parsed) : provider;
}

const RUNTIME_LABEL_COLLATOR = new Intl.Collator("en", { sensitivity: "base" });

export function compareRuntimeProvidersByLabel(a: RuntimeProvider, b: RuntimeProvider): number {
  return RUNTIME_LABEL_COLLATOR.compare(runtimeProviderLabel(a), runtimeProviderLabel(b));
}

export function sortedRuntimeProviders(providers: Iterable<RuntimeProvider>): RuntimeProvider[] {
  return [...new Set(providers)].sort(compareRuntimeProvidersByLabel);
}
