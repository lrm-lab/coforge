export type AgentReadinessFacts = {
  state: string;
  detail?: string | null;
};

export type AgentReadinessLine =
  | "computer_updating"
  | "computer_offline"
  | "runtime_missing"
  | "runtime_login_required"
  | "launch_failed";

export function agentReadinessLine(readiness: AgentReadinessFacts): AgentReadinessLine | null {
  switch (readiness.state) {
    case "computer_updating":
    case "computer_offline":
    case "runtime_missing":
    case "runtime_login_required":
      return readiness.state;
    case "launch_failed":
      return readiness.detail === "runtime_login_required"
        ? "runtime_login_required"
        : "launch_failed";
    default:
      return null;
  }
}

export type RuntimeMissingKind = "install" | "unusable" | "unconfirmed" | "unknown";

export function runtimeMissingKind(detail: string | null | undefined): RuntimeMissingKind {
  switch (detail) {
    case "runtime_missing":
      return "install";
    case "runtime_unusable":
      return "unusable";
    case "runtime_unconfirmed":
      return "unconfirmed";
    default:
      return "unknown";
  }
}

export type LaunchFailureReason =
  | "runtime_not_found"
  | "runtime_not_installed"
  | "runtime_unusable"
  | "runtime_unavailable"
  | "runtime_private"
  | "runtime_version_too_old"
  | "auth_failed"
  | "agent_authorization_failed"
  | "model_not_found"
  | "model_provider_not_configured"
  | "agent_environment_invalid"
  | "startup_deadline_exceeded"
  | "runtime_start_failed"
  | "stalled_restart_limit"
  | "generic";

const RUNTIME_NAMED: ReadonlySet<LaunchFailureReason> = new Set([
  "runtime_not_found",
  "runtime_not_installed",
  "runtime_unusable",
  "runtime_unavailable",
  "runtime_private",
  "runtime_version_too_old",
  "runtime_start_failed",
  "model_not_found",
]);

export const LAUNCH_FAILURE_FIXABLE: ReadonlySet<LaunchFailureReason> = new Set([
  "model_not_found",
  "model_provider_not_configured",
  "agent_environment_invalid",
]);

export function launchFailureNeedsRuntime(reason: LaunchFailureReason): boolean {
  return RUNTIME_NAMED.has(reason);
}

export function launchFailureReason(code: string | null | undefined): LaunchFailureReason {
  switch (code) {
    case "runtime_not_found":
    case "runtime_not_installed":
    case "runtime_unusable":
    case "runtime_unavailable":
    case "runtime_private":
    case "runtime_version_too_old":
    case "auth_failed":
    case "agent_authorization_failed":
    case "model_not_found":
    case "model_provider_not_configured":
    case "agent_environment_invalid":
    case "startup_deadline_exceeded":
    case "stalled_restart_limit":
      return code;
    case "runtime_start_failed":
    case "runtime_spawn_failed":
      return "runtime_start_failed";
    default:
      return "generic";
  }
}
