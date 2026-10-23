import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Alert } from "#src/components/ui/alert";
import { m } from "#src/paraglide/messages";
import { webhookProblem } from "./app-notification-copy";
import type { WebhookStatus } from "./app-webhook";
import { loadAppWebhook, type AppWebhookSummary } from "./app-webhooks.functions";
import { WebhookDeliveryStatus } from "./webhook-delivery-status";

/**
 * How deliveries of the app's events to this Workspace's installation are going, for an owner or
 * admin (the app detail): last delivery, last error, failures in a row, and why they stopped. Read
 * when the detail opens, and again when the webhook's state in the list changes.
 */
export function AppWebhookDelivery({
  appKey,
  status,
}: {
  appKey: string;
  status: WebhookStatus | undefined;
}) {
  const load = useServerFn(loadAppWebhook);
  const [webhook, setWebhook] = useState<AppWebhookSummary | null>();
  const [problem, setProblem] = useState("");
  useEffect(() => {
    let current = true;
    setProblem("");
    load({ data: { key: appKey } }).then(
      (loaded) => current && setWebhook(loaded),
      (cause) => current && setProblem(webhookProblem(cause, m.apps_notifications_error_load)),
    );
    return () => {
      current = false;
    };
  }, [appKey, status, load]);
  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-semibold text-primary">
        {m.apps_notifications_installation_webhook()}
      </h3>
      {problem ? (
        <Alert color="error" title={problem} />
      ) : webhook?.status !== "enabled" ? (
        <p className="text-sm text-tertiary">
          {webhook?.status === "setup"
            ? m.apps_notifications_installation_webhook_setup()
            : m.apps_notifications_installation_webhook_off()}
        </p>
      ) : (
        <WebhookDeliveryStatus status={webhook.installations[0]?.status ?? null} />
      )}
    </section>
  );
}
