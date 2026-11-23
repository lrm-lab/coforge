import type { AlertColor } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";
import type {
  ComputerUpgradeProgress,
  ComputerUpgradeStatus,
  UpgradeWorkspaceProgress,
  UpgradeWorkspaceProgressState,
} from "./computer.schemas";

export type UpgradeStepTone = "complete" | "current" | "incomplete" | "warn" | "error";

export type UpgradeProgressStep = {
  id: "download" | "drain" | "switch" | "reconnect";
  label: string;
  status: UpgradeStepTone;
};

export type UpgradeProgressWorkspaceRow = {
  workspaceId: string;
  name: string;
  label: string;
  tone: "good" | "warn" | "muted";
};

export type ComputerUpgradeProgressView = {
  version: string;
  alertColor: AlertColor;
  title: string;
  headline: string;
  detail: string;
  steps: UpgradeProgressStep[];
  workspaces: UpgradeProgressWorkspaceRow[];
  canRetry: boolean;
};

function stepLabels() {
  return {
    download: m.computer_upgrade_progress_step_download(),
    drain: m.computer_upgrade_progress_step_drain(),
    switch: m.computer_upgrade_progress_step_switch(),
    reconnect: m.computer_upgrade_progress_step_reconnect(),
  };
}

function reachedStage(phase: ComputerUpgradeProgress["phase"]): 0 | 1 | 2 | 3 {
  if (phase === "downloading" || phase === "verifying") return 1;
  if (phase === "waiting") return 2;
  if (phase === "switching" || phase === "uncertain") return 3;
  return 0;
}

export function effectiveWorkspaceState(
  row: UpgradeWorkspaceProgress,
  reconnectUntil: number | undefined,
  now: number,
): UpgradeWorkspaceProgressState {
  if (row.state === "waiting" && reconnectUntil !== undefined && now >= reconnectUntil) {
    return "unconfirmed";
  }
  return row.state;
}

function workspaceRowView(
  row: UpgradeWorkspaceProgress,
  reconnectUntil: number | undefined,
  now: number,
): UpgradeProgressWorkspaceRow {
  const state = effectiveWorkspaceState(row, reconnectUntil, now);
  switch (state) {
    case "restored":
      return {
        workspaceId: row.workspaceId,
        name: row.name,
        label: m.computer_upgrade_workspace_restored(),
        tone: "good",
      };
    case "waiting":
      return {
        workspaceId: row.workspaceId,
        name: row.name,
        label: m.computer_upgrade_workspace_waiting(),
        tone: "muted",
      };
    case "unconfirmed":
      return {
        workspaceId: row.workspaceId,
        name: row.name,
        label: m.computer_upgrade_workspace_unconfirmed(),
        tone: "warn",
      };
    case "not_running":
      return {
        workspaceId: row.workspaceId,
        name: row.name,
        label: m.computer_upgrade_workspace_not_running(),
        tone: "muted",
      };
    case "unknown":
      return {
        workspaceId: row.workspaceId,
        name: row.name,
        label: m.computer_upgrade_workspace_unknown(),
        tone: "muted",
      };
  }
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

function buildSteps(
  progress: ComputerUpgradeProgress,
  effectiveWorkspaces: UpgradeWorkspaceProgressState[],
  now: number,
): UpgradeProgressStep[] {
  const labels = stepLabels();
  const stage = reachedStage(progress.phase);
  const { switchState } = progress;

  let s1: UpgradeStepTone = stage >= 2 ? "complete" : stage === 1 ? "current" : "incomplete";
  let s2: UpgradeStepTone = stage >= 3 ? "complete" : stage === 2 ? "current" : "incomplete";
  let s3: UpgradeStepTone = stage === 3 ? "current" : "incomplete";
  let s4: UpgradeStepTone = "incomplete";

  if (switchState === "target_online") {
    s3 = now >= progress.expiresAt ? "warn" : "current";
  } else if (switchState === "confirmed") {
    s3 = "complete";
    const hasWaiting = effectiveWorkspaces.some((state) => state === "waiting");
    const hasUnsettled = effectiveWorkspaces.some(
      (state) => state === "unconfirmed" || state === "unknown",
    );
    s4 = hasWaiting ? "current" : hasUnsettled ? "warn" : "complete";
  } else if (switchState === "uncertain") {
    s3 = "warn";
  } else if (
    switchState === "rolled_back" ||
    switchState === "failed" ||
    switchState === "conflict"
  ) {
    if (stage === 1) s1 = "error";
    else if (stage === 2) s2 = "error";
    else s3 = "error";
  }

  return [
    { id: "download", label: labels.download, status: s1 },
    { id: "drain", label: labels.drain, status: s2 },
    { id: "switch", label: labels.switch, status: s3 },
    { id: "reconnect", label: labels.reconnect, status: s4 },
  ];
}

function pendingSummary(progress: ComputerUpgradeProgress) {
  switch (progress.phase) {
    case "downloading":
      return {
        headline: m.computer_upgrade_progress_downloading(),
        detail: m.computer_upgrade_progress_downloading_detail(),
      };
    case "verifying":
      return {
        headline: m.computer_upgrade_progress_verifying(),
        detail: m.computer_upgrade_progress_verifying_detail(),
      };
    case "waiting":
      return {
        headline: m.computer_upgrade_progress_draining(),
        detail: m.computer_upgrade_progress_draining_detail(),
      };
    case "switching":
      return {
        headline: m.computer_upgrade_progress_switching(),
        detail: m.computer_upgrade_progress_switching_detail(),
      };
    default:
      return {
        headline: m.computer_upgrade_progress_awaiting_stage(),
        detail: m.computer_upgrade_progress_awaiting_stage_detail(),
      };
  }
}

function confirmedSummary(
  progress: ComputerUpgradeProgress,
  effectiveWorkspaces: UpgradeWorkspaceProgressState[],
  now: number,
) {
  const recoverable = effectiveWorkspaces.filter((state) => state !== "not_running");
  const restored = recoverable.filter((state) => state === "restored").length;
  const hasWaiting = effectiveWorkspaces.some((state) => state === "waiting");
  const hasUnsettled = effectiveWorkspaces.some(
    (state) => state === "unconfirmed" || state === "unknown",
  );
  let detail: string;
  if (recoverable.length > 0) {
    const base = m.computer_upgrade_progress_workspace_summary({
      restored: String(restored),
      total: String(recoverable.length),
    });
    if (hasWaiting && progress.reconnectUntil !== undefined && progress.reconnectUntil > now) {
      const seconds = Math.max(0, Math.ceil((progress.reconnectUntil - now) / 1000));
      detail = m.computer_upgrade_progress_reconnect_countdown({
        summary: base,
        seconds: String(seconds),
      });
    } else {
      detail = base;
    }
  } else if (effectiveWorkspaces.length > 0) {
    detail = m.computer_upgrade_progress_confirmed_none_running_detail();
  } else {
    detail = m.computer_upgrade_progress_confirmed_all_detail();
  }
  const alertColor: AlertColor = hasWaiting ? "brand" : hasUnsettled ? "warning" : "success";
  return {
    alertColor,
    headline: m.computer_upgrade_progress_confirmed(),
    detail,
  };
}

export function buildComputerUpgradeProgressView(input: {
  progress: ComputerUpgradeProgress;
  status?: ComputerUpgradeStatus;
  failureHeadline?: string;
  now?: number;
}): ComputerUpgradeProgressView {
  const { progress, status, failureHeadline, now = Date.now() } = input;
  const effectiveStates = progress.workspaces.map((row) =>
    effectiveWorkspaceState(row, progress.reconnectUntil, now),
  );
  const steps = buildSteps(progress, effectiveStates, now);
  const workspaces = progress.workspaces.map((row) =>
    workspaceRowView(row, progress.reconnectUntil, now),
  );
  const title = m.computer_upgrade_progress_title({ version: progress.expectedVersion });

  switch (progress.switchState) {
    case "pending": {
      const copy = pendingSummary(progress);
      return {
        version: progress.expectedVersion,
        alertColor: "brand",
        title,
        headline: copy.headline,
        detail: copy.detail,
        steps,
        workspaces,
        canRetry: false,
      };
    }
    case "target_online": {
      const expired = now >= progress.expiresAt;
      return {
        version: progress.expectedVersion,
        alertColor: expired ? "warning" : "brand",
        title,
        headline: m.computer_upgrade_progress_target_online(),
        detail: expired
          ? m.computer_upgrade_progress_target_online_expired_detail()
          : m.computer_upgrade_progress_target_online_detail(),
        steps,
        workspaces,
        canRetry: false,
      };
    }
    case "confirmed": {
      const copy = confirmedSummary(progress, effectiveStates, now);
      return {
        version: progress.expectedVersion,
        alertColor: copy.alertColor,
        title,
        headline: copy.headline,
        detail: copy.detail,
        steps,
        workspaces,
        canRetry: false,
      };
    }
    case "rolled_back": {
      const restored =
        progress.restoredVersion ??
        (status?.status === "failed" && status.reason === "version-mismatch"
          ? status.actualVersion
          : undefined);
      return {
        version: progress.expectedVersion,
        alertColor: "error",
        title,
        headline: restored
          ? m.computer_upgrade_progress_rolled_back({ version: restored })
          : m.computer_upgrade_progress_rolled_back_unknown(),
        detail: restored
          ? m.computer_upgrade_progress_rolled_back_detail()
          : m.computer_upgrade_progress_rolled_back_unknown_detail(),
        steps,
        workspaces: [],
        canRetry: true,
      };
    }
    case "uncertain":
      return {
        version: progress.expectedVersion,
        alertColor: "warning",
        title,
        headline: m.computer_upgrade_progress_uncertain(),
        detail: m.computer_upgrade_progress_uncertain_detail(),
        steps,
        workspaces,
        canRetry: false,
      };
    case "conflict":
      return {
        version: progress.expectedVersion,
        alertColor: "error",
        title,
        headline: m.computer_upgrade_progress_conflict(),
        detail: m.computer_upgrade_progress_conflict_detail(),
        steps,
        workspaces,
        canRetry: true,
      };
    case "failed":
      return {
        version: progress.expectedVersion,
        alertColor: "error",
        title,
        headline: m.computer_upgrade_progress_failed(),
        detail: failureHeadline ?? m.computer_upgrade_progress_rolled_back_detail(),
        steps,
        workspaces: [],
        canRetry: true,
      };
  }
}
