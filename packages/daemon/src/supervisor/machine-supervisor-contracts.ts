import type { DaemonConnectRejectionReason, RunnerHoldReason } from "@lrm/coforge-sdk/internal";
import type { DaemonConfig } from "#src/daemon-runtime/runtime";
import type { RunnerHoldSnapshot } from "./runner-hold";
import { WorkspaceParkedError } from "./workspace-health-journal";
import { WorkspaceLifecycleSupersededError } from "./lifecycle-superseded-error";
import type {
  LifecycleFailure,
  RestartResult,
  UpgradeOperation,
} from "./machine-supervisor-operations";

/** What a supervisor is given and answers with: a binding, the process seams under it, and the
 * shapes one operator command's answer takes. Split out of `machine-supervisor.ts` when that file
 * reached its size limit; the package's public surface is unchanged. */
export type RestartProgress = {
  requestId: string;
  phase: "stopping" | "starting";
  previousInstanceId: string | null;
};
export type ManagedBinding = DaemonConfig & {
  enabled: boolean;
  restart?: RestartProgress;
  restartResults?: RestartResult[];
  /** Legacy cloud ready hints, never proof of a completed local operation. */
  restartRequestIds?: string[];
  upgradeRequestIds?: string[];
  /** Pre-receipt dedupe list; FileBindingStore reopens these as pending operations. */
  upgradeRequests?: { requestId: string; expectedVersion: string }[];
  upgradeOperations?: UpgradeOperation[];
  /** The last operator command that failed for this Workspace after it had already answered, so
   * `coforge-computer status` can say so; cleared by the next one that succeeds. */
  lastFailure?: LifecycleFailure;
  /** `daemon:detach` (task #417): the server already answered once, so a retry finishes the
   * local half alone — stop, unbind, delete the credential — without asking again. */
  detachConfirmed?: boolean;
  /** `daemon:detach`: the server answered `computer_key_revoked` (task #417). */
  detachKeyRevoked?: boolean;
};

export class WorkspaceRecoveryError extends AggregateError {}
export interface BindingStore {
  load(): Promise<ManagedBinding[]>;
  save(bindings: ManagedBinding[]): Promise<void>;
}
/**
 * An operator command's one deadline (epoch ms). It bounds when the command answers, not the work:
 * what is still under way at the deadline finishes in the serialized queue after the answer.
 */
export type CommandOptions = { deadline?: number };
/** Which targeted Workspaces an operator command finished starting, and which were still under
 * way (queued, holding, stopping, or starting) when its deadline came. */
export type CommandAnswer = { started: string[]; pending: string[] };

/** What one command has got through so far, read when its deadline answers before it finishes:
 * its targets are handled in order, so the first `done` of them are finished. */
export type CommandProgress = {
  targets?: string[];
  done: number;
  started: string[];
  refused?: WorkspaceParkedError;
  superseded?: WorkspaceLifecycleSupersededError;
  /** Ends a target's under-way mark once it has been handled. */
  settle(workspaceId: string): void;
};

export interface WorkspaceProcesses {
  /** Gives up with `signal.reason` once `signal` aborts (a stop or configure took over). */
  start(binding: ManagedBinding, options?: { signal?: AbortSignal }): Promise<string>;
  stop(binding: ManagedBinding): Promise<void>;
  instance(binding: ManagedBinding): Promise<string | null>;
  /**
   * Asks one Workspace daemon to stop admitting new turns and reports which of its Agents are
   * still busy. Optional: a `WorkspaceProcesses` that cannot reach its children simply restarts
   * with today's behaviour.
   */
  hold?(binding: ManagedBinding, reason: RunnerHoldReason): Promise<RunnerHoldSnapshot>;
  /** Lifts a hold on a daemon that, against expectations, survived: only called when the OS stop
   * after a hold failed, so the still-running daemon does not sit held with nobody to lift it. */
  release?(binding: ManagedBinding, reason: RunnerHoldReason): Promise<unknown>;
  /** Clears this Workspace's crash/terminal health latch. Called only for an explicit operator
   * `start`/`restart` through `command()` - never from automatic recovery on Coordinator startup,
   * and never from `stop` - so an OS-level crash-loop restart (which never reaches `command()`)
   * cannot clear its own latch. Optional: a `WorkspaceProcesses` with no health journal to clear
   * simply never latches. */
  clearHealth?(binding: ManagedBinding): Promise<void>;
  /** Why the cloud refused this Workspace for good, if it did. A parked Workspace is never
   * started by recovery, start, or restart; only `configure` (a rebind) lifts the park. */
  parkedReason?(binding: ManagedBinding): Promise<DaemonConnectRejectionReason | undefined>;
  clearParked?(binding: ManagedBinding): Promise<void>;
}

/** Test seam for the bounded restart hold; production takes every default. */
export type RestartHoldTuning = {
  holdMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};
