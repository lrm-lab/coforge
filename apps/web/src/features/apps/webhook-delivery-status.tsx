import type { ReactNode } from "react";

import { Alert } from "#src/components/ui/alert";
import { KeyValueList, KeyValueRow } from "#src/components/ui/key-value-list";
import { RelativeTime } from "#src/components/ui/relative-time";
import { m } from "#src/paraglide/messages";
import { WEBHOOK_STOPPED_REASONS } from "./app-notification-copy";
import type { WebhookStatusSummary } from "./app-webhooks.functions";

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
  const rows: { term: string; value: ReactNode; mono?: boolean }[] = [
    {
      term: m.apps_notifications_delivery_last(),
      value: status.lastDeliveryAt ? (
        <RelativeTime value={status.lastDeliveryAt} />
      ) : (
        m.apps_notifications_delivery_never()
      ),
    },
  ];
  if (status.lastError) {
    rows.push({
      term: m.apps_notifications_delivery_error(),
      value: <code>{status.lastError}</code>,
      mono: true,
    });
  }
  if (status.consecutiveFailures > 0) {
    rows.push({
      term: m.apps_notifications_delivery_failures(),
      value: status.consecutiveFailures,
    });
  }
  if (status.nextAttemptAt) {
    rows.push({
      term: m.apps_notifications_delivery_next(),
      value: <RelativeTime value={status.nextAttemptAt} />,
    });
  }
  return (
    <KeyValueList labelWidth="wide" className="gap-y-1.5">
      {rows.map((row) => (
        <KeyValueRow key={row.term} label={row.term} mono={row.mono}>
          {row.value}
        </KeyValueRow>
      ))}
    </KeyValueList>
  );
}
