import type { ReactNode } from "react";

import { Alert } from "#src/components/ui/alert";
import { RelativeTime } from "#src/components/ui/relative-time";
import { m } from "#src/paraglide/messages";
import { WEBHOOK_STOPPED_REASONS } from "./app-notification-copy";
import type { WebhookStatusSummary } from "./app-webhooks.functions";

/**
 * How deliveries to one installation's endpoint are going, for an owner or admin: stopped (with
 * why and how to resume), or the last delivery, the last error, the failures in a row and the next
 * attempt. A response body is never part of it.
 */
export function WebhookDeliveryStatus({ status }: { status: WebhookStatusSummary | null }) {
  if (!status)
    return <p className="text-sm text-tertiary">{m.apps_notifications_delivery_none()}</p>;
  if (status.disabledReason) {
    return (
      <Alert
        color="warning"
        title={m.apps_notifications_delivery_stopped()}
        description={`${WEBHOOK_STOPPED_REASONS[status.disabledReason]()} ${m.apps_notifications_delivery_stopped_hint()}`}
      />
    );
  }
  const rows: [string, ReactNode][] = [
    [
      m.apps_notifications_delivery_last(),
      status.lastDeliveryAt ? (
        <RelativeTime value={status.lastDeliveryAt} />
      ) : (
        m.apps_notifications_delivery_never()
      ),
    ],
  ];
  if (status.lastError) {
    rows.push([m.apps_notifications_delivery_error(), <code>{status.lastError}</code>]);
  }
  if (status.consecutiveFailures > 0) {
    rows.push([m.apps_notifications_delivery_failures(), status.consecutiveFailures]);
  }
  if (status.nextAttemptAt) {
    rows.push([
      m.apps_notifications_delivery_next(),
      <RelativeTime value={status.nextAttemptAt} />,
    ]);
  }
  return (
    <dl className="grid gap-1 text-sm">
      {rows.map(([term, value]) => (
        <div key={term} className="flex flex-wrap gap-x-2">
          <dt className="text-tertiary">{term}</dt>
          <dd className="text-secondary">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
