import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";

/** What a person sees of one move of an Agent between Computers. */
export type AgentMigrationSummary = { state: string; errorCode: string | null };

const IN_PROGRESS = new Set(["requested", "source_stopped", "uploaded", "placing", "switched"]);

/** Whether the move is still going: its status keeps changing and it may be canceled. */
export function isAgentMigrationInProgress(state: string) {
  return IN_PROGRESS.has(state);
}

/** One line for where a move stands, naming the Computer it goes to. */
export function agentMigrationStatusLine(migration: AgentMigrationSummary, computer: string) {
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
      return m.agent_migration_status_completed({ computer });
    case "canceled":
      return m.agent_migration_status_canceled();
    default:
      return m.agent_migration_status_failed({ reason: migration.errorCode ?? "unexpected" });
  }
}

const REFUSALS: Record<string, () => string> = {
  "agent-migrating": m.agent_migration_error_already_moving,
  "agent-migration-same-computer": m.agent_migration_error_same_computer,
  "agent-migration-target-unavailable": m.agent_migration_error_target_unavailable,
  "agent-migration-source-unreachable": m.agent_migration_error_source_unreachable,
  "agent-migration-unavailable": m.agent_migration_error_unavailable,
};

/** Why a move or its cancel was refused; a retry is offered only when it can help. */
export function agentMigrationErrorMessage(cause: unknown) {
  if (isAppErrorCode(cause, "ACCESS_DENIED")) return m.agent_form_not_authorized();
  const known =
    isAppErrorCode(cause, "INVALID_INPUT", "CONFLICT", "TEMPORARILY_UNAVAILABLE") && cause.errorId
      ? REFUSALS[cause.errorId]
      : undefined;
  return known ? known() : m.agent_migration_error_generic();
}
