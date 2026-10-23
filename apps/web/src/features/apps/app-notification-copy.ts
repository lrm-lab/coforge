import { isAppError } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import type { AppNotificationEventName } from "./app-notification-events";
import {
  APP_NOTIFICATIONS_OFF,
  APP_WEBHOOK_ENDPOINT_INVALID,
  APP_WEBHOOK_ENDPOINT_UNREACHABLE,
  APP_WEBHOOK_UNAVAILABLE,
  type WebhookDisabledReason,
} from "./app-webhook";

/** Each event as the editor names it; a `Record` so a new event cannot ship without its copy. */
export const APP_NOTIFICATION_EVENT_LABELS: Record<AppNotificationEventName, () => string> = {
  "workspace.member_added": m.apps_notification_event_workspace_member_added,
  "workspace.member_removed": m.apps_notification_event_workspace_member_removed,
  "workspace.member_role_changed": m.apps_notification_event_workspace_member_role_changed,
  "workspace.config_updated": m.apps_notification_event_workspace_config_updated,
  "workspace.public_channel_created": m.apps_notification_event_workspace_public_channel_created,
  "workspace.public_channel_archived": m.apps_notification_event_workspace_public_channel_archived,
  "channel.member_added": m.apps_notification_event_channel_member_added,
  "channel.member_removed": m.apps_notification_event_channel_member_removed,
  "channel.config_updated": m.apps_notification_event_channel_config_updated,
  "channel.archived": m.apps_notification_event_channel_archived,
  "thread.created": m.apps_notification_event_thread_created,
  "agent.status_changed": m.apps_notification_event_agent_status_changed,
  "agent.profile_updated": m.apps_notification_event_agent_profile_updated,
  "agent.runtime_changed": m.apps_notification_event_agent_runtime_changed,
  "agent.model_changed": m.apps_notification_event_agent_model_changed,
  "computer.online": m.apps_notification_event_computer_online,
  "computer.offline": m.apps_notification_event_computer_offline,
  "computer.version_changed": m.apps_notification_event_computer_version_changed,
  "computer.agent_started": m.apps_notification_event_computer_agent_started,
  "computer.agent_stopped": m.apps_notification_event_computer_agent_stopped,
};

/** Why deliveries to an installation stopped, in words. */
export const WEBHOOK_STOPPED_REASONS: Record<WebhookDisabledReason, () => string> = {
  endpoint_rejected: m.apps_notifications_stopped_endpoint_rejected,
  retries_exhausted: m.apps_notifications_stopped_retries_exhausted,
  payload_too_large: m.apps_notifications_stopped_payload_too_large,
  endpoint_invalid: m.apps_notifications_stopped_endpoint_invalid,
};

/** A refused webhook change as the section shows it: what its `errorId` says, else `fallback`. */
export function webhookProblem(cause: unknown, fallback: () => string): string {
  const errorId = isAppError(cause) ? cause.errorId : undefined;
  if (errorId === APP_WEBHOOK_ENDPOINT_INVALID)
    return m.apps_notifications_error_endpoint_invalid();
  if (errorId === APP_WEBHOOK_ENDPOINT_UNREACHABLE)
    return m.apps_notifications_error_endpoint_not_public();
  if (errorId === APP_WEBHOOK_UNAVAILABLE) return m.apps_notifications_error_unavailable();
  if (errorId === APP_NOTIFICATIONS_OFF) return m.apps_notifications_error_off();
  return fallback();
}
