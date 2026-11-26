import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";
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
import commandCodeMark from "./marks/command-code.svg";
import droidMark from "./marks/droid.svg";

export {
  compareRuntimeProvidersByLabel,
  RUNTIME_PROVIDER_DISPLAY_ORDER,
  runtimeProviderDisplayName,
  runtimeProviderLabel,
  sortedRuntimeProviders,
} from "./runtime-provider-label";

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
