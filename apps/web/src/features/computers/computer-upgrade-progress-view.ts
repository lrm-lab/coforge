import { m } from "#src/paraglide/messages";
import { isPrereleaseVersion } from "./computer-identity";
import type {
  ComputerUpgradeProgress,
  ComputerUpgradeStatus,
  UpgradeWorkspaceProgress,
  UpgradeWorkspaceProgressState,
} from "./computer.schemas";
import {
  computerUpgradeNoticeId,
  computerUpgradeSettledToastable,
  describeComputerUpgradeSuccess,
  type FollowedComputerUpgrade,
} from "./computer-upgrade-status";
import type { ComputerUpgradeSlotState } from "./computer-upgrade-slot-state";
import { upgradeOutcome, type UpgradeRequestErrorCopy } from "./upgrade-failure";

export type ComputerUpgradeProgressView =
  | {
      kind: "active";
      version: string;
    }
  | {
      kind: "completed";
      version: string;
    }
  | {
      kind: "issue";
      version: string;
      alertColor: "warning" | "error";
      title: string;
      detail: string;
      unsettledWorkspaces: string[];
      canRetry: boolean;
    };

export type RuntimeUpgradeHeaderAction =
  | { kind: "upgrade"; disabled: boolean }
  | { kind: "upgrading"; disabled: true }
  | { kind: "retry"; disabled: boolean };

export type RuntimeUpgradeVersionNotice =
  | { kind: "available"; version: string; prerelease: boolean; offline: boolean }
  | { kind: "upgrading"; version?: string }
  | {
      kind: "issue";
      tone: "error" | "warning";
      title: string;
      detail: string;
      steps?: UpgradeRequestErrorCopy["steps"];
      errorId?: string;
      unsettledWorkspaces?: string[];
    };

export type RuntimeUpgradePresentation = {
  headerAction?: RuntimeUpgradeHeaderAction;
  versionNotice?: RuntimeUpgradeVersionNotice;
};

function effectiveWorkspaceState(
  row: UpgradeWorkspaceProgress,
  reconnectUntil: number | undefined,
  now: number,
): UpgradeWorkspaceProgressState {
  if (row.state === "waiting" && reconnectUntil !== undefined && now >= reconnectUntil) {
    return "unconfirmed";
  }
  return row.state;
}

export function nextProgressDeadline(
  progress: ComputerUpgradeProgress,
  now: number,
): number | undefined {
  if (progress.switchState === "target_online" && now < progress.expiresAt) {
    return progress.expiresAt;
  }
  if (
    progress.switchState === "confirmed" &&
    progress.workspaces.some((row) => row.state === "waiting") &&
    progress.reconnectUntil !== undefined &&
    now < progress.reconnectUntil
  ) {
    return progress.reconnectUntil;
  }
  return undefined;
}

export function resolveProgressComputerVersion(input: {
  computerVersion?: string | null;
  liveStatus?: ComputerUpgradeStatus;
}): string | null | undefined {
  const { computerVersion, liveStatus } = input;
  const progress = liveStatus?.progress;
  if (!progress) return undefined;
  if (progress.switchState === "rolled_back") {
    if (progress.restoredVersion) return progress.restoredVersion;
    if (liveStatus.status === "failed" && liveStatus.reason === "version-mismatch") {
      return liveStatus.actualVersion ?? computerVersion;
    }
    return computerVersion;
  }
  if (progress.switchState === "target_online" || progress.switchState === "confirmed") {
    if (liveStatus.status === "completed" && liveStatus.computerVersion) {
      return liveStatus.computerVersion;
    }
    return progress.expectedVersion;
  }
  if (liveStatus.status === "completed" && liveStatus.computerVersion) {
    return liveStatus.computerVersion;
  }
  return computerVersion;
}

function unsettledWorkspaceNames(progress: ComputerUpgradeProgress, now: number): string[] {
  return progress.workspaces
    .filter((row) => {
      const state = effectiveWorkspaceState(row, progress.reconnectUntil, now);
      return state === "unconfirmed" || state === "unknown";
    })
    .map((row) => row.name);
}

export function buildComputerUpgradeProgressView(input: {
  progress: ComputerUpgradeProgress;
  status?: ComputerUpgradeStatus;
  failureHeadline?: string;
  now?: number;
}): ComputerUpgradeProgressView {
  const { progress, status, failureHeadline, now = Date.now() } = input;
  const version = progress.expectedVersion;

  switch (progress.switchState) {
    case "pending":
      return { kind: "active", version };
    case "target_online": {
      if (now < progress.expiresAt) {
        return { kind: "active", version };
      }
      return {
        kind: "issue",
        version,
        alertColor: "warning",
        title: m.computer_upgrade_progress_title({ version }),
        detail: m.computer_upgrade_progress_target_online_expired_detail(),
        unsettledWorkspaces: [],
        canRetry: false,
      };
    }
    case "confirmed": {
      const hasWaiting = progress.workspaces.some(
        (row) => effectiveWorkspaceState(row, progress.reconnectUntil, now) === "waiting",
      );
      if (hasWaiting) {
        return { kind: "active", version };
      }
      const unsettled = unsettledWorkspaceNames(progress, now);
      if (unsettled.length > 0) {
        return {
          kind: "issue",
          version,
          alertColor: "warning",
          title: m.computer_upgrade_progress_title({ version }),
          detail: m.computer_upgrade_progress_workspaces_unconfirmed_detail({ version }),
          unsettledWorkspaces: unsettled,
          canRetry: false,
        };
      }
      return { kind: "completed", version };
    }
    case "rolled_back": {
      const restored =
        progress.restoredVersion ??
        (status?.status === "failed" && status.reason === "version-mismatch"
          ? status.actualVersion
          : undefined);
      return {
        kind: "issue",
        version,
        alertColor: "error",
        title: m.computer_upgrade_failed_title({ version }),
        detail: restored
          ? m.computer_upgrade_progress_rolled_back({ version: restored })
          : m.computer_upgrade_progress_rolled_back_unknown(),
        unsettledWorkspaces: [],
        canRetry: true,
      };
    }
    case "uncertain":
      return {
        kind: "issue",
        version,
        alertColor: "warning",
        title: m.computer_upgrade_progress_title({ version }),
        detail: m.computer_upgrade_progress_uncertain_detail(),
        unsettledWorkspaces: unsettledWorkspaceNames(progress, now),
        canRetry: false,
      };
    case "conflict":
      return {
        kind: "issue",
        version,
        alertColor: "error",
        title: m.computer_upgrade_failed_title({ version }),
        detail: m.computer_upgrade_progress_conflict_detail(),
        unsettledWorkspaces: [],
        canRetry: true,
      };
    case "failed":
      return {
        kind: "issue",
        version,
        alertColor: "error",
        title: m.computer_upgrade_failed_title({ version }),
        detail: failureHeadline ?? m.computer_upgrade_progress_failed_detail(),
        unsettledWorkspaces: [],
        canRetry: true,
      };
  }
}

export function runtimeUpgradePresentation(input: {
  slot: ComputerUpgradeSlotState | null;
  canUpgrade: boolean;
  online: boolean;
  upgradeInFlight: boolean;
  now?: number;
}): RuntimeUpgradePresentation {
  const { slot, canUpgrade, online, upgradeInFlight, now = Date.now() } = input;
  if (!slot) {
    return {};
  }
  if (slot.state === "available") {
    return {
      headerAction: canUpgrade
        ? { kind: "upgrade", disabled: !online || upgradeInFlight }
        : undefined,
      versionNotice: {
        kind: "available",
        version: slot.offer,
        prerelease: isPrereleaseVersion(slot.offer),
        offline: !online,
      },
    };
  }
  if (slot.state === "upgrading") {
    return {
      headerAction: canUpgrade ? { kind: "upgrading", disabled: true } : undefined,
      versionNotice: { kind: "upgrading", version: slot.version },
    };
  }
  if (slot.state === "progress") {
    const view = buildComputerUpgradeProgressView({
      progress: slot.progress,
      status: slot.status,
      failureHeadline: slot.failure?.headline,
      now,
    });
    if (view.kind === "active") {
      return {
        headerAction: canUpgrade ? { kind: "upgrading", disabled: true } : undefined,
        versionNotice: { kind: "upgrading", version: view.version },
      };
    }
    if (view.kind === "completed") {
      if (slot.offer !== undefined) {
        return {
          headerAction: canUpgrade
            ? { kind: "upgrade", disabled: !online || upgradeInFlight }
            : undefined,
          versionNotice: {
            kind: "available",
            version: slot.offer,
            prerelease: isPrereleaseVersion(slot.offer),
            offline: !online,
          },
        };
      }
      return {};
    }
    const canRetry = canUpgrade && view.canRetry && slot.offer !== undefined;
    return {
      headerAction: canRetry ? { kind: "retry", disabled: !online || upgradeInFlight } : undefined,
      versionNotice: {
        kind: "issue",
        tone: view.alertColor,
        title: view.title,
        detail: view.detail,
        steps: slot.failure?.steps,
        errorId: slot.failure?.errorId,
        unsettledWorkspaces: view.unsettledWorkspaces,
      },
    };
  }
  const canRetry = canUpgrade && slot.offer !== undefined;
  return {
    headerAction: canRetry ? { kind: "retry", disabled: !online || upgradeInFlight } : undefined,
    versionNotice: {
      kind: "issue",
      tone: "error",
      title: slot.version
        ? m.computer_upgrade_failed_title({ version: slot.version })
        : m.computer_upgrade_failed_title_generic(),
      detail: slot.failure.headline,
      steps: slot.failure.steps,
      errorId: slot.failure.errorId,
    },
  };
}

export type ComputerUpgradeFailureNotice = {
  id: string;
  title: string;
  body: string;
};

export function describeComputerUpgradeFailureNotice(input: {
  upgrade: FollowedComputerUpgrade;
  status: ComputerUpgradeStatus | null | undefined;
  now?: number;
}): ComputerUpgradeFailureNotice | null {
  const { upgrade, status, now = Date.now() } = input;
  if (status && computerUpgradeSettledToastable(status)) return null;
  const id = computerUpgradeNoticeId(upgrade.computerId);
  const name = upgrade.computerName;
  if (status?.progress) {
    const outcome = upgradeOutcome(status, now);
    const view = buildComputerUpgradeProgressView({
      progress: status.progress,
      status,
      failureHeadline: outcome.state === "failed" ? outcome.failure.headline : undefined,
      now,
    });
    if (view.kind === "completed") return null;
    if (view.kind === "issue") {
      const title = name
        ? view.alertColor === "error"
          ? m.computer_upgrade_failed_notice_title({ name })
          : m.computer_upgrade_issue_notice_title({ name })
        : view.title;
      const body =
        view.unsettledWorkspaces.length > 0
          ? `${view.detail} ${view.unsettledWorkspaces.join(", ")}`
          : view.detail;
      return { id, title, body };
    }
  }
  if (status?.status === "failed") {
    const outcome = upgradeOutcome(status, now);
    const title = name
      ? m.computer_upgrade_failed_notice_title({ name })
      : upgrade.version
        ? m.computer_upgrade_failed_title({ version: upgrade.version })
        : m.computer_upgrade_failed_title_generic();
    const body =
      outcome.state === "failed"
        ? outcome.failure.headline
        : m.computer_upgrade_progress_failed_detail();
    return { id, title, body };
  }
  const title = name
    ? m.computer_upgrade_issue_notice_title({ name })
    : upgrade.version
      ? m.computer_upgrade_progress_title({ version: upgrade.version })
      : m.computer_upgrade_failed_title_generic();
  return { id, title, body: m.computer_upgrade_progress_uncertain_detail() };
}

export function describeComputerUpgradeProgressToast(
  active: readonly FollowedComputerUpgrade[],
): string | null {
  if (active.length === 0) return null;
  if (active.length > 1) {
    return m.computer_upgrade_running_multiple({ count: String(active.length) });
  }
  const only = active[0]!;
  if (only.computerName && only.version) {
    return m.computer_upgrade_running_named({ name: only.computerName, version: only.version });
  }
  if (only.computerName) {
    return m.computer_upgrade_running_named_generic({ name: only.computerName });
  }
  return only.version
    ? m.computer_upgrade_running_title({ version: only.version })
    : m.computer_upgrade_in_progress();
}

export function describeComputerUpgradeSuccessBatch(
  succeeded: readonly { version: string; computerName?: string }[],
): string | null {
  if (succeeded.length === 0) return null;
  if (succeeded.length > 1) {
    return m.computer_upgrade_succeeded_multiple_toast({ count: String(succeeded.length) });
  }
  const only = succeeded[0]!;
  return describeComputerUpgradeSuccess(only.version, only.computerName);
}
