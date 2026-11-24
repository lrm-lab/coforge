import {
  parseRuntimeProvider,
  RUNTIME_PROVIDER,
  type RuntimeProvider,
} from "@lrm/coforge-sdk/internal";
import antigravityMark from "@lobehub/icons-static-svg/icons/antigravity-color.svg";
import claudeCodeMark from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import codexMark from "@lobehub/icons-static-svg/icons/codex-color.svg";
import devinMark from "@lobehub/icons-static-svg/icons/devin-color.svg";
import deepseekMark from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import cursorMark from "@lobehub/icons-static-svg/icons/cursor.svg";
import kiroMark from "@lobehub/icons-static-svg/icons/kiro-color.svg";
import grokMark from "@lobehub/icons-static-svg/icons/grok.svg";
import opencodeMark from "@lobehub/icons-static-svg/icons/opencode.svg";
import piMark from "@lobehub/icons-static-svg/icons/pi.svg";
import { m } from "#src/paraglide/messages";
// Not in @lobehub/icons: the vector mark from Command Code's own site, kept in this repo.
import commandCodeMark from "./marks/command-code.svg";
// Not in @lobehub/icons: Factory's rotor mark, from factory.ai/favicon.svg (see the file header).
import droidMark from "./marks/droid.svg";

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

export const RUNTIME_PROVIDER_MARK: Record<
  Exclude<RuntimeProvider, typeof RUNTIME_PROVIDER.COFORGE>,
  string
> = {
  [RUNTIME_PROVIDER.PI]: piMark,
  [RUNTIME_PROVIDER.CODEX]: codexMark,
  [RUNTIME_PROVIDER.CLAUDE_CODE]: claudeCodeMark,
  [RUNTIME_PROVIDER.KIRO]: kiroMark,
  [RUNTIME_PROVIDER.CURSOR]: cursorMark,
  [RUNTIME_PROVIDER.OPENCODE]: opencodeMark,
  [RUNTIME_PROVIDER.GROK]: grokMark,
  [RUNTIME_PROVIDER.ANTIGRAVITY]: antigravityMark,
  [RUNTIME_PROVIDER.DSH]: deepseekMark,
  [RUNTIME_PROVIDER.COMMAND_CODE]: commandCodeMark,
  [RUNTIME_PROVIDER.DEVIN]: devinMark,
  [RUNTIME_PROVIDER.DROID]: droidMark,
};

export const RUNTIME_PROVIDER_MARK_IS_COLOR_ICON: Record<
  Exclude<RuntimeProvider, typeof RUNTIME_PROVIDER.COFORGE>,
  boolean
> = {
  [RUNTIME_PROVIDER.PI]: false,
  [RUNTIME_PROVIDER.CODEX]: true,
  [RUNTIME_PROVIDER.CLAUDE_CODE]: true,
  [RUNTIME_PROVIDER.KIRO]: true,
  [RUNTIME_PROVIDER.CURSOR]: false,
  [RUNTIME_PROVIDER.OPENCODE]: false,
  [RUNTIME_PROVIDER.GROK]: false,
  [RUNTIME_PROVIDER.ANTIGRAVITY]: true,
  [RUNTIME_PROVIDER.DSH]: true,
  [RUNTIME_PROVIDER.COMMAND_CODE]: false,
  [RUNTIME_PROVIDER.DEVIN]: true,
  [RUNTIME_PROVIDER.DROID]: false,
};
