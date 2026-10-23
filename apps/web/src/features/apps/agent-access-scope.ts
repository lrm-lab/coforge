/**
 * Which Agents may use an installed app, as both the browser and the server
 * (`server/app-agent-access/`) name it. Pure and client-safe.
 *
 * `all` (the default): every Agent in the Workspace, later ones included. `selected`: only the
 * Agents chosen for the installation. Raft has no per-Agent install scope, so Selected Agents is
 * a CoForge extension. Switching the mode revokes no grant a person or an earlier use gave.
 */
export const AGENT_ACCESS_MODES = ["all", "selected"] as const;
export type AgentAccessMode = (typeof AGENT_ACCESS_MODES)[number];

/** The mode a stored value names; anything but `all` fails closed to `selected`. */
export const toAgentAccessMode = (value: string): AgentAccessMode =>
  value === "all" ? "all" : "selected";

/** An installation's Agent access, as the app editor and the app detail show it. Everyone sees
 * the mode and the number of Agents; an owner or admin also gets the selection and the Agents to
 * choose from. */
export type AgentAccessScopeView = {
  mode: AgentAccessMode;
  /** The selected Agents; null while every Agent may. */
  count: number | null;
  agentIds?: string[];
  candidates?: { id: string; name: string }[];
};

/** The most Agents one selection names. */
export const AGENT_ACCESS_SELECTION_MAX = 500;
