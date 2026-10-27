import type { AppPublishStatus } from "#src/features/apps/app-publish-status";

/** The app row a manager works on, as `AppOwnerAgents` read it once. */
export type ManagedAppRow = {
  id: string;
  key: string;
  name: string;
  description: string;
  redirectUris: string[];
  logoObjectKey: string | null;
  publishStatus: AppPublishStatus;
  ownerWorkspaceId: string;
  ownerAgentId: string | null;
};

/**
 * An app an Agent may manage: the proof that `AppOwnerAgents.manager` judged the Agent (the owner
 * Agent, or an admin-role Agent of the app's Workspace, alive) and the app row it read. The
 * registry, `AppShareLinks` and `AppPublishing` take it through their `...Managed...` operations
 * and do what is asked of the app without judging who asks.
 */
export type ManagedApp = {
  readonly workspaceId: string;
  readonly app: ManagedAppRow;
};
