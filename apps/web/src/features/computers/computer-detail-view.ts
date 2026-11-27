import type {
  DaemonConnectRejectionReason,
  RuntimeProvider,
  RuntimeUnavailableCode,
  AgentDisplaySnapshot,
} from "@lrm/coforge-sdk/internal";
import type { RuntimeAuthProvider, RuntimeAuthStatus } from "@lrm/coforge-anvil";

import type { ComputerIdentity } from "./computer-identity";
import type { MachineStatusView } from "./computer-machine-status";
import type { ComputerUpgradeStatus } from "./computer.schemas";
import type { UsageReadResult } from "#src/server/centrifugo/usage-cache.server";

export const RESTART_POLL_INTERVAL_MS = 2_000;
export const RESTART_MAX_POLLS = 31;

export type ComputerDetailView = ComputerIdentity & {
  id: string;
  ownedByCurrentUser: boolean;
  canManageAgents: boolean;
  online: boolean;
  connectRefusal?: { reason: DaemonConnectRejectionReason; at: string } | null;
  runtimeDetecting?: boolean;
  connectedAt: Date | string;
  computerVersion?: string | null;
  releaseChannel?: string;
  imageVersion?: string | null;
  imageUpdate?: { version: string } | null;
  upgrade?: ComputerUpgradeStatus | null;
  upgradeProgressRequestId?: string;
  platform?: string | null;
  osVersion?: string | null;
  machine?: MachineStatusView;
  creator?: {
    displayName: string | null;
    username: string;
    avatarUrl: string | null;
  };
  runtimeAuth?: Partial<Record<RuntimeAuthProvider, RuntimeAuthStatus>>;
  runtimeUsages?: Partial<Record<RuntimeProvider, UsageReadResult>>;
  runtimes: {
    id: string;
    provider: RuntimeProvider;
    version: string;
    displayName: string;
    unavailableCode?: RuntimeUnavailableCode | null;
    diagnostic?: string | null;
    isPublic: boolean;
  }[];
  agents: {
    id: string;
    name: string;
    displayName: string;
    avatarUrl: string | null;
    ownedByCurrentUser?: boolean;
    stopped?: boolean;
    hasApiKey?: boolean;
    provider?: RuntimeProvider;
    runtimeAuthSource?: "shared" | "own" | "unknown";
    runtimeConfig?: {
      model?: string;
      modelProvider?: string;
      reasoning?: string;
      fastMode?: boolean;
      contextWindow?: number;
      maxOutputTokens?: number;
    };
    runtimeConfigInvalid?: boolean;
    display?: AgentDisplaySnapshot;
  }[];
};
