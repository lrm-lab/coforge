import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Input } from "#src/components/base/input/input";
import { Toggle } from "#src/components/base/toggle/toggle";
import { Alert } from "#src/components/ui/alert";
import { ConfirmDialog } from "#src/components/ui/confirm-dialog";
import { Popconfirm } from "#src/components/ui/popconfirm";
import { useReportDirty } from "#src/components/ui/unsaved-changes-dialog";
import { m } from "#src/paraglide/messages";
import { webhookProblem } from "./app-notification-copy";
import { NotificationEventsField } from "./app-notification-events-field";
import { EditorSection } from "./app-editor-fields";
import {
  eventsAllowedBy,
  sameNotificationEvents,
  type AppNotificationEventName,
} from "./app-notification-events";
import type { AppPermissionGroup, AppPermissionsSummary } from "./app-permissions";
import type { WebhookStatus } from "./app-webhook";
import { SecretValueAlert } from "./app-secret-panel";
import {
  disableAppWebhook,
  enableAppWebhook,
  loadAppWebhook,
  rotateAppWebhookSecret,
  saveAppWebhookEndpoint,
  type AppWebhookSummary,
} from "./app-webhooks.functions";
import { WebhookDeliveryStatus } from "./webhook-delivery-status";

/** What the section shows: the server's webhook state, or Loading until it is read. */
type SectionState = WebhookStatus | "loading";

const STATE_LABELS: Record<SectionState, () => string> = {
  loading: m.apps_notifications_status_loading,
  enabled: m.apps_notifications_status_enabled,
  setup: m.apps_notifications_status_setup,
  off: m.apps_notifications_status_off,
};

/**
 * The events chosen in the form (saved with its Save, atomically with the groups), starting from
 * the saved ones and replaced when a newer declaration is read. `submitted` is what Save sends
 * (only events the chosen `groups` cover); `unsaved` whether it differs from the saved events.
 */
export function useNotificationEvents(
  permissions: AppPermissionsSummary | undefined,
  groups: readonly AppPermissionGroup[],
) {
  const [events, setEvents] = useState<AppNotificationEventName[]>(() => permissions?.events ?? []);
  const [shownRevision, setShownRevision] = useState(permissions?.revision);
  if (permissions && permissions.revision !== shownRevision) {
    setShownRevision(permissions.revision);
    setEvents(permissions.events);
  }
  const submitted = eventsAllowedBy(events, groups);
  return {
    events,
    setEvents,
    submitted,
    unsaved: permissions !== undefined && !sameNotificationEvents(submitted, permissions.events),
  };
}

type Pending = "enable" | "save" | "rotate" | "disable" | null;

/**
 * App notifications: the app's signed webhook and the events it subscribes to, as an editor section
 * (Experimental). The switch, the endpoint (its own Save endpoint), the secret rotation and the
 * delivery status act at once, outside the form's Save, and the status (Off, Setup, Enabled) is the
 * server's: switching on enables the webhook without an endpoint (Setup, nothing delivered) and
 * switching off deletes the endpoint. The events are the form's, saved with it. While registering
 * (`appKey` absent) the switch waits for the app to exist. The signing secret is shown once, by
 * the call that made it, and dropped with the section.
 */
export function NotificationsSection({
  id,
  appKey,
  groups,
  events,
  isDisabled,
  onEventsChange,
  onEndpointDirtyChange,
}: {
  id: string;
  appKey: string | undefined;
  groups: readonly AppPermissionGroup[];
  events: readonly AppNotificationEventName[];
  isDisabled: boolean;
  onEventsChange: (events: AppNotificationEventName[]) => void;
  onEndpointDirtyChange?: (dirty: boolean) => void;
}) {
  const load = useServerFn(loadAppWebhook);
  const enable = useServerFn(enableAppWebhook);
  const save = useServerFn(saveAppWebhookEndpoint);
  const rotate = useServerFn(rotateAppWebhookSecret);
  const disable = useServerFn(disableAppWebhook);
  const [webhook, setWebhook] = useState<AppWebhookSummary | null>();
  const [endpoint, setEndpoint] = useState("");
  const [pending, setPending] = useState<Pending>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [problem, setProblem] = useState("");
  const [secret, setSecret] = useState<string | null>(null);

  useEffect(() => {
    if (appKey === undefined) return;
    let current = true;
    load({ data: { key: appKey } }).then(
      (loaded) => {
        if (!current) return;
        setWebhook(loaded);
        setEndpoint(loaded?.endpointUrl ?? "");
      },
      (cause) => current && setProblem(webhookProblem(cause, m.apps_notifications_error_load)),
    );
    return () => {
      current = false;
    };
  }, [appKey, load]);

  const state: SectionState =
    appKey !== undefined && webhook === undefined ? "loading" : (webhook?.status ?? "off");
  const on = state === "setup" || state === "enabled";
  const endpointDirty =
    on && webhook !== undefined && endpoint.trim() !== (webhook?.endpointUrl ?? "").trim();
  useReportDirty(endpointDirty, onEndpointDirtyChange);

  /** Runs a change that acts at once; a refusal shows inline. */
  async function act(
    kind: Exclude<Pending, null>,
    fallback: () => string,
    run: () => Promise<void>,
  ) {
    setPending(kind);
    setProblem("");
    try {
      await run();
    } catch (cause) {
      setProblem(webhookProblem(cause, fallback));
    } finally {
      setPending(null);
    }
  }

  function saveEndpoint(key: string) {
    void act("save", m.apps_notifications_error_save, async () => {
      const changed = await save({ data: { key, endpointUrl: endpoint.trim() } });
      setWebhook(changed.webhook);
      if (changed.signingSecret) setSecret(changed.signingSecret);
    });
  }

  function toggle(key: string, next: boolean) {
    void act(next ? "enable" : "disable", m.apps_notifications_error_toggle, async () => {
      const changed = await (next ? enable : disable)({ data: { key } });
      setWebhook(changed.webhook);
      if (!next) {
        setEndpoint("");
        setSecret(null);
      }
    });
  }

  const busy = isDisabled || pending !== null;
  const installation = webhook?.installations[0];
  return (
    <EditorSection
      id={id}
      title={m.apps_notifications_section()}
      status={STATE_LABELS[state]()}
      description={m.apps_notifications_section_description()}
      badge={m.apps_notifications_experimental()}
    >
      <div className="grid gap-5 [&>*]:min-w-0">
        {problem && <Alert color="error" title={problem} />}
        <div className="grid gap-4 rounded-xl border border-secondary p-4 [&>*]:min-w-0">
          <Toggle
            className="w-full max-w-full"
            label={m.apps_notifications_enable_title()}
            hint={
              appKey === undefined
                ? m.apps_notifications_save_first()
                : m.apps_notifications_enable_description()
            }
            isSelected={on}
            isDisabled={busy || appKey === undefined || state === "loading"}
            onChange={(next) => {
              if (appKey === undefined) return;
              if (!next && state === "enabled") setConfirmDisable(true);
              else toggle(appKey, next);
            }}
          />
          {on && appKey !== undefined && (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <Input
                  className="min-w-0 flex-1"
                  label={m.apps_notifications_endpoint_label()}
                  type="url"
                  inputMode="url"
                  placeholder={m.apps_notifications_endpoint_placeholder()}
                  value={endpoint}
                  isDisabled={busy}
                  onChange={setEndpoint}
                  // Enter saves the endpoint, not the form.
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    if (endpoint.trim() !== "") saveEndpoint(appKey);
                  }}
                />
                <Button
                  type="button"
                  size="md"
                  color="secondary"
                  isDisabled={busy || endpoint.trim() === ""}
                  isLoading={pending === "save"}
                  showTextWhileLoading
                  onPress={() => saveEndpoint(appKey)}
                >
                  {pending === "save"
                    ? m.apps_notifications_saving_endpoint()
                    : m.apps_notifications_save_endpoint()}
                </Button>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {state === "enabled" && webhook ? (
                  <Badge size="sm" color="success">
                    {m.apps_notifications_enabled_revision({ revision: webhook.revision })}
                  </Badge>
                ) : (
                  <p className="text-sm text-tertiary">{m.apps_notifications_enter_endpoint()}</p>
                )}
                {state === "enabled" && (
                  <Popconfirm
                    title={m.apps_notifications_rotate_secret()}
                    description={m.apps_notifications_rotate_hint()}
                    confirmLabel={m.apps_notifications_rotate_secret()}
                    pendingLabel={m.apps_notifications_rotating()}
                    errorMessage={(cause) =>
                      webhookProblem(cause, m.apps_notifications_error_rotate)
                    }
                    placement="bottom start"
                    isDisabled={busy}
                    onConfirm={async () => {
                      const changed = await rotate({ data: { key: appKey } });
                      setWebhook(changed.webhook);
                      if (changed.signingSecret) setSecret(changed.signingSecret);
                    }}
                  >
                    <Button
                      type="button"
                      size="sm"
                      color="secondary"
                      isDisabled={busy}
                      isLoading={pending === "rotate"}
                      showTextWhileLoading
                    >
                      {pending === "rotate"
                        ? m.apps_notifications_rotating()
                        : m.apps_notifications_rotate_secret()}
                    </Button>
                  </Popconfirm>
                )}
              </div>
              {state === "enabled" && (
                <p className="text-sm text-tertiary">{m.apps_notifications_rotate_hint()}</p>
              )}
            </>
          )}
          {secret && (
            <SecretValueAlert
              title={m.apps_notifications_secret_title()}
              notice={m.apps_notifications_secret_once()}
              value={secret}
              copyLabel={m.apps_notifications_copy_secret()}
            />
          )}
          {state === "enabled" && (
            <div className="grid gap-1.5">
              <p className="text-sm font-semibold text-primary">
                {m.apps_notifications_delivery_title()}
              </p>
              <WebhookDeliveryStatus status={installation?.status ?? null} />
            </div>
          )}
        </div>
        <NotificationEventsField
          groups={groups}
          events={events}
          isDisabled={isDisabled}
          onChange={onEventsChange}
        />
      </div>
      <ConfirmDialog
        open={confirmDisable}
        onOpenChange={setConfirmDisable}
        title={m.apps_notifications_enable_title()}
        description={m.apps_notifications_enable_description()}
        confirmLabel={m.apps_notifications_status_off()}
        errorMessage={(cause) => webhookProblem(cause, m.apps_notifications_error_toggle)}
        onConfirm={async () => {
          if (appKey === undefined) return;
          const changed = await disable({ data: { key: appKey } });
          setWebhook(changed.webhook);
          setEndpoint("");
          setSecret(null);
          setConfirmDisable(false);
        }}
      />
    </EditorSection>
  );
}
