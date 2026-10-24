import type { Workspace } from "./index";

export type WorkspaceInfoRequest = { idempotencyKey: string };
export type WorkspaceInfoResponse = {
  idempotencyKey: string;
  workspace: Workspace;
  humans: { id: string; name: string; displayName: string; role: string; description?: string }[];
  agents: {
    id: string;
    name: string;
    displayName: string;
    role: string;
    status: string;
    activity: string;
    activityDetail: string;
    runtime: string;
    model: string;
    computerName: string;
    daemonVersion: string;
    description?: string;
  }[];
  /** The calling Agent's own Workspace role (`owner`, `admin` or `member`); absent when unknown. */
  serverRole?: string;
  /** The Workspace's channels by name; absent from a server that does not send them. */
  channels?: WorkspaceInfoChannel[];
  /** The Computers connected to the Workspace; absent from a server that does not send them. */
  computers?: WorkspaceInfoComputer[];
  projects: {
    id: string;
    name: string;
    slug: string;
    githubFullName: string;
    githubHtmlUrl: string;
  }[];
  /**
   * The calling Agent's own authoritative identity, mirroring the launch-config response's
   * `identity.runtimeContext` (`buildAgentLaunchIdentity` in
   * `apps/web/src/routes/api/agent-api-keys.ts`, built from the same shared
   * `buildAgentRuntimeContext`). Every field is optional and omitted rather than sent empty, so an
   * older CLI decoder degrades cleanly. Never carries another Agent's runtime config. Named type
   * `WorkspaceInfoRuntimeContext` lives in `@lrm/coforge-sdk/agent` (`client.ts`) instead of here,
   * so the two subpaths never export a same-named type.
   */
  runtimeContext?: {
    agentId?: string;
    agentName?: string;
    runtime?: string;
    model?: string;
    reasoning?: string;
    workspaceId?: string;
    workspaceSlug?: string;
    workspaceName?: string;
    computerId?: string;
    computerName?: string;
    computerHostname?: string;
    computerOs?: string;
    computerVersion?: string;
    // The CLI fills this from `COFORGE_CURRENT_AGENT_WORKSPACE_PATH`; the server never sends it
    // (only the local Computer knows the Agent workspace path).
    agentWorkspacePath?: string;
  };
};

export type WorkspaceInfoChannel = {
  /** `#name`. */
  name: string;
  description: string;
  joined: boolean;
  muted: boolean;
  archived: boolean;
  /** The calling Agent's stored role in the channel; only while it is a member. */
  channelRole?: string;
  /** Why the calling Agent may administer the channel: its Workspace role or its channel role. */
  channelAdminBasis?: "server_role" | "channel_role";
  /** ISO time of the newest message; `null` for a channel nobody has posted in. */
  lastPostAt: string | null;
};

export type WorkspaceInfoComputer = {
  name: string;
  displayName: string;
  /** `online` or `offline`, from the Computer's connection status. */
  status: string;
  platform?: string;
  osVersion?: string;
  computerVersion?: string;
};
