import { Badge } from "#src/components/base/badges/badges";
import { m } from "#src/paraglide/messages";
import type { WebhookStatus } from "./app-webhook";

const BADGES = {
  enabled: { color: "success", label: m.apps_notifications_card_enabled },
  setup: { color: "warning", label: m.apps_notifications_card_setup },
  off: { color: "gray", label: m.apps_notifications_card_off },
} as const;

/** An app's webhook state as a badge on its card. */
export function WebhookStatusBadge({ status }: { status: WebhookStatus }) {
  const { color, label } = BADGES[status];
  return (
    <Badge size="sm" color={color}>
      {label()}
    </Badge>
  );
}
