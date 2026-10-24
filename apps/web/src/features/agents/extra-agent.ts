import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import type { AgentMascot } from "./agent-mascot";
import type { AgentVisibility } from "./agent-visibility";

/**
 * An Agent the viewer may see beyond their own roster, as `loadExtraAgents` sends it and the app
 * shell's Agent store holds it (`isExtra`). A contract, not behavior: the server and the browser
 * both import it, and it imports neither.
 */
export type ExtraAgent = {
  id: string;
  /** The Agent's handle. */
  name: string;
  displayName: string;
  avatarUrl: string;
  mascot: AgentMascot;
  visibility: AgentVisibility;
  /** Present only for an Agent that is busy now or that the browser held busy or lapsed (the
   * read's `heldAgentIds`); absent for the others, and when the display read failed. */
  display?: AgentDisplaySnapshot;
};

/** The most `heldAgentIds` one extras read names; the browser caps its ids and the server ignores
 * the rest, so a long list never fails the read. */
export const HELD_AGENT_IDS_LIMIT = 500;
