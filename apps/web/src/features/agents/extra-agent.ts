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
  /** Absent for an Agent with no Computer, or when the display read failed. */
  display?: AgentDisplaySnapshot;
};
