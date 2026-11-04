/** Who welcomes a new human member: their own platform assistant, one chosen Agent, or nobody. */
export const WORKSPACE_ONBOARDING_MODES = ["assistant", "agent", "off"] as const;
export type WorkspaceOnboardingMode = (typeof WORKSPACE_ONBOARDING_MODES)[number];

/** A Workspace's new-member onboarding settings, as an owner or admin sees and saves them. */
export type WorkspaceOnboardingSettings = {
  mode: WorkspaceOnboardingMode;
  /** The welcoming Agent; set exactly when `mode` is `agent`. */
  agentId: string | null;
  /** Whether an Agent created from now on also introduces itself in `#general`. */
  newAgentGreeting: boolean;
  /** The Agents the picker offers, by name. */
  agents: { id: string; name: string; avatarUrl: string | null }[];
};
