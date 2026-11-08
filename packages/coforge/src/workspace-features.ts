/** The Workspace's feature switches the Daemon exported at launch (`COFORGE_WORKSPACE_FEATURES`,
 * `packages/daemon/src/code-agent/environment.ts`). The variable is daemon-owned: `agentEnvironment`
 * clears any inherited or Agent-configured value before installing the launch's, so a parsed
 * `false` is the server's word, not a spoof. Absent or unparsable means an older Daemon that
 * states no features — callers then keep the full surface rather than guess at gates (task #711). */
export type CoforgeWorkspaceFeatures = {
  taskConversations?: boolean;
  artifacts?: boolean;
};

export function workspaceFeatures(): CoforgeWorkspaceFeatures | undefined {
  const raw = Bun.env.COFORGE_WORKSPACE_FEATURES;
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const features: CoforgeWorkspaceFeatures = {};
  if (typeof record.taskConversations === "boolean")
    features.taskConversations = record.taskConversations;
  if (typeof record.artifacts === "boolean") features.artifacts = record.artifacts;
  return Object.keys(features).length > 0 ? features : undefined;
}

/** Whether the launch's stated features switch the `artifact` command family off. Only an
 * explicit `false` hides it: a launch that states no features keeps the help as it was. */
export function artifactCommandsHidden(): boolean {
  return workspaceFeatures()?.artifacts === false;
}
