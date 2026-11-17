import type { AgentRuntimeEvent } from "@coforge/agent";
import { AGENT_RUNTIME_EVENT_TYPE } from "#src/contract";

export function acpContextUsage(update: Readonly<Record<string, unknown>>): AgentRuntimeEvent[] {
  const { used, size } = update;
  return typeof used === "number" &&
    typeof size === "number" &&
    Number.isFinite(used) &&
    Number.isFinite(size) &&
    used >= 0 &&
    size > 0
    ? [{ type: AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE, usedTokens: used, windowTokens: size }]
    : [];
}
