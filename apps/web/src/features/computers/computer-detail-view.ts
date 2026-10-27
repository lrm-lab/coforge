import type { RuntimeProvider, AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import type { RuntimeAuthProvider, RuntimeAuthStatus } from "@lrm/coforge-anvil";

import type { ComputerIdentity } from "./computer-identity";
import type { ComputerUpgradeStatus } from "./computer.schemas";

export const RESTART_POLL_INTERVAL_MS = 2_000;
export const RESTART_MAX_POLLS = 31;

export type ComputerDetailView = ComputerIdentity & {
  id: string;
  ownedByCurrentUser: boolean;
  canManageAgents: boolean;
  online: boolean;
  /** A rescan of its runtimes is in flight; the runtimes listed are the last confirmed ones. */
  runtimeDetecting?: boolean;
  connectedAt: Date | string;
  computerVersion?: string | null;
  /** The cloud image this computer is running. Absent for a local computer. */
  imageVersion?: string | null;
  imageUpdate?: { version: string } | null;
  /** This Computer's latest upgrade while the server keeps its record; `null` when none. */
  upgrade?: ComputerUpgradeStatus | null;
  platform?: string | null;
  osVersion?: string | null;
  creator?: {
    displayName: string | null;
    username: string;
    avatarUrl: string | null;
  };
  /** Each visible login-capable runtime's status, account fields only for those allowed them. */
  runtimeAuth?: Partial<Record<RuntimeAuthProvider, RuntimeAuthStatus>>;
  runtimes: {
    id: string;
    provider: RuntimeProvider;
    version: string;
    displayName: string;
    isPublic: boolean;
  }[];
  agents: {
    id: string;
    name: string;
    displayName: string;
    avatarUrl: string | null;
    provider: RuntimeProvider;
    runtimeConfig: { model?: string; modelProvider?: string };
    display?: AgentDisplaySnapshot;
  }[];
};
