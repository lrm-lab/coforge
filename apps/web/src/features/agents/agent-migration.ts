import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";

/** What a person sees of one move of an Agent between Computers. */
export type AgentMigrationSummary = { state: string; errorCode: string | null };

const IN_PROGRESS = new Set(["requested", "source_stopped", "uploaded", "placing", "switched"]);

/** Whether the move is still going: its status keeps changing and it may be canceled. */
export function isAgentMigrationInProgress(state: string) {
  return IN_PROGRESS.has(state);
}

/** The four steps a move goes through, in order, and the states in which each is under way. */
const STEPS: { label: () => string; under: readonly string[] }[] = [
  { label: m.agent_migration_step_stop, under: ["requested"] },
  { label: m.agent_migration_step_upload, under: ["source_stopped"] },
  { label: m.agent_migration_step_place, under: ["uploaded", "placing"] },
  { label: m.agent_migration_step_start, under: ["switched"] },
];

export type AgentMigrationStepStatus = "done" | "current" | "pending";

function stepStatus(index: number, reached: number): AgentMigrationStepStatus {
  if (reached < 0 || index > reached) return "pending";
  return index < reached ? "done" : "current";
}

/**
 * A move as its four steps: those it has passed are done, the one it is in is current. A move
 * that ended before completing shows none as done; its status line says how it ended.
 */
export function agentMigrationSteps(state: string) {
  const reached =
    state === "completed" ? STEPS.length : STEPS.findIndex((step) => step.under.includes(state));
  return STEPS.map((step, index) => ({
    label: step.label(),
    status: stepStatus(index, reached),
  }));
}

/** How long a move that ended stays shown; after that the profile shows no move at all. */
const SHOWN_AFTER_END_MS = 24 * 60 * 60 * 1000;

/** Whether a move is worth showing: one still going, or one that ended within the last day. */
export function isAgentMigrationShown(
  migration: { state: string; updatedAt: string },
  now = Date.now(),
) {
  return (
    isAgentMigrationInProgress(migration.state) ||
    now - Date.parse(migration.updatedAt) < SHOWN_AFTER_END_MS
  );
}

const REASONS: Record<string, () => string> = {
  lease_expired: m.agent_migration_reason_lease_expired,
  agent_moved: m.agent_migration_reason_agent_moved,
  target_unavailable: m.agent_migration_reason_target_unavailable,
  bundle_too_large: m.agent_migration_reason_too_large,
  insufficient_disk: m.agent_migration_reason_disk,
  workspace_in_use: m.agent_migration_reason_in_use,
};

/** Why a move failed, in words; every code not named here reads as a failed transfer. */
function failureReason(errorCode: string | null) {
  return (errorCode ? REASONS[errorCode] : undefined)?.() ?? m.agent_migration_reason_transfer();
}

/** One line for where a move stands, naming the Computer it goes to. */
export function agentMigrationStatusLine(
  migration: AgentMigrationSummary,
  computer: string,
  source: string,
) {
  switch (migration.state) {
    case "requested":
      return m.agent_migration_status_stopping({ computer });
    case "source_stopped":
      return m.agent_migration_status_uploading({ computer });
    case "uploaded":
    case "placing":
      return m.agent_migration_status_placing({ computer });
    case "switched":
      return m.agent_migration_status_starting({ computer });
    case "completed":
      return m.agent_migration_status_completed({ source, computer });
    case "canceled":
      return m.agent_migration_status_canceled();
    default:
      return m.agent_migration_status_failed({ reason: failureReason(migration.errorCode) });
  }
}

const REFUSALS: Record<string, () => string> = {
  "agent-migrating": m.agent_migration_error_already_moving,
  "agent-migration-unplaced": m.agent_migration_error_unplaced,
  "agent-migration-runtime-unavailable": m.agent_migration_error_runtime_unavailable,
  "agent-migration-source-outdated": m.agent_migration_source_outdated,
  "agent-migration-source-offline": m.agent_migration_source_offline,
  "agent-migration-target-outdated": m.agent_migration_target_outdated,
  "agent-migration-target-offline": m.agent_migration_target_offline,
  "agent-migration-same-computer": m.agent_migration_error_same_computer,
  "agent-migration-target-unavailable": m.agent_migration_error_target_unavailable,
  "agent-migration-source-unreachable": m.agent_migration_error_source_unreachable,
  "agent-migration-unavailable": m.agent_migration_error_unavailable,
};

type Readiness = "ready" | "outdated" | "offline";

/** Why the Agent's own Computer cannot start a move now, or null when it can. */
export function agentMigrationSourceNote(source: Readiness | null) {
  if (source === "outdated") return m.agent_migration_source_outdated();
  if (source === "offline") return m.agent_migration_source_offline();
  return null;
}

/** Why a Computer cannot take the Agent now, or null when it can be picked. */
export function agentMigrationTargetNote(target: { readiness: Readiness; runsAgent: boolean }) {
  if (target.readiness === "offline") return m.agent_migration_target_note_offline();
  if (target.readiness === "outdated") return m.agent_migration_target_note_outdated();
  if (!target.runsAgent) return m.agent_migration_target_note_runtime();
  return null;
}

/** Why a move or its cancel was refused; a retry is offered only when it can help. */
export function agentMigrationErrorMessage(cause: unknown) {
  if (isAppErrorCode(cause, "ACCESS_DENIED")) return m.agent_form_not_authorized();
  const known =
    isAppErrorCode(cause, "INVALID_INPUT", "CONFLICT", "TEMPORARILY_UNAVAILABLE") && cause.errorId
      ? REFUSALS[cause.errorId]
      : undefined;
  return known ? known() : m.agent_migration_error_generic();
}
