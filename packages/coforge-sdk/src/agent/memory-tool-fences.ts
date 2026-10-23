/**
 * Memory Agent launch fences. This value travels on AgentStartIntent.toolProfile
 * and is intentionally distinct from Workspace Memory Profile persistence
 * (`off | openviking`).
 */

import { OPENVIKING_TOOL_NAMES, OPENVIKING_TOOL_PROFILE } from "./openviking-memory";

export const MEMORY_AGENT_TOOL_PROFILES = [OPENVIKING_TOOL_PROFILE] as const;
export type MemoryAgentToolProfile = (typeof MEMORY_AGENT_TOOL_PROFILES)[number];

export const WORKSPACE_MEMORY_PROFILES = ["off", "openviking"] as const;
export type WorkspaceMemoryProfileName = (typeof WORKSPACE_MEMORY_PROFILES)[number];

const OPENVIKING_FENCE_TOOLS = [
  // ov_fork_find / ov_expand stay in the SDK for other callers but are not on the Memory Agent
  // fence: ov_experience_find serves both skill cards and fork guards as self-contained cited items.
  OPENVIKING_TOOL_NAMES.experienceFind,
  OPENVIKING_TOOL_NAMES.offer,
  OPENVIKING_TOOL_NAMES.diagnose,
] as const;

export function isMemoryAgentToolProfile(value: unknown): value is MemoryAgentToolProfile {
  return (
    typeof value === "string" && (MEMORY_AGENT_TOOL_PROFILES as readonly string[]).includes(value)
  );
}

export function toolsForMemoryFence(profile: MemoryAgentToolProfile): readonly string[] {
  void profile;
  return OPENVIKING_FENCE_TOOLS;
}

export function workspaceProfileToToolFence(
  profile: WorkspaceMemoryProfileName,
): MemoryAgentToolProfile | undefined {
  if (profile === "openviking") return OPENVIKING_TOOL_PROFILE;
  return undefined;
}
