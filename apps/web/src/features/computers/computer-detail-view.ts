import type {
  RuntimeProvider,
  RuntimeUnavailableCode,
  AgentDisplaySnapshot,
} from "@lrm/coforge-sdk/internal";
import type { RuntimeAuthProvider, RuntimeAuthStatus } from "@lrm/coforge-anvil";

import type { ComputerIdentity } from "./computer-identity";
import type { MachineStatusView } from "./computer-machine-status";
import type { ComputerUpgradeStatus } from "./computer.schemas";

/** What a rescan the page asked for came back with: the daemon answered, or it did not in time,
 * or it answered with a failure of its own. */
export type RuntimeRescanResult =
  | { status: "refreshed" | "timeout" }
  | { status: "error"; message?: string };

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
  /** What the Computer last reported about its disk and memory; `null` per kind when unknown. */
  machine?: MachineStatusView;
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
    /** Set when the runtime is installed but cannot be used; it is never selectable then. */
    unavailableCode?: RuntimeUnavailableCode | null;
    /** The CLI's own redacted stderr line, verbatim; only with an `unavailableCode`. */
    diagnostic?: string | null;
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
