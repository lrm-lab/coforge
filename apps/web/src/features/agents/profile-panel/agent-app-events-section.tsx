import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { Badge, BadgeWithDot } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { RelativeTime } from "#src/components/ui/relative-time";
import {
  decideAgentAppEventRequest,
  loadAgentAppEvents,
  revokeAgentAppEventGrant,
  type AgentAppEvents,
} from "#src/features/agents/agent-app-events.functions";
import { AppLogo } from "#src/features/apps/app-logo";
import { m } from "#src/paraglide/messages";
import { SECTION_CAPTION_CLASS } from "./inline-edit-field";

/**
 * The Apps tab's App events section (Agent inbound, behind `app-agent-events`): the apps waiting
 * for approval to send to the Agent, the apps that may, and the events they sent, newest first. An
 * event is information from an app, so its payload is shown as inert text. Only those who may
 * change the Agent's app access (`canManage`) get Approve, Deny and Revoke. It renders nothing
 * while the feature is off for the Workspace or the read has not arrived.
 */
export function AgentAppEventsSection({
  agentId,
  timeZone,
}: {
  agentId: string;
  timeZone: string | null;
}) {
  const load = useServerFn(loadAgentAppEvents);
  const query = useQuery({
    queryKey: ["agent-app-events", agentId],
    queryFn: () => load({ data: { agentId } }),
  });
  const decide = useServerFn(decideAgentAppEventRequest);
  const revoke = useServerFn(revokeAgentAppEventGrant);
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<string>();

  const act = async (id: string, action: () => Promise<unknown>, failed: string) => {
    setBusy(id);
    setFailure(undefined);
    try {
      await action();
    } catch {
      setFailure(failed);
    } finally {
      await query.refetch();
      setBusy(undefined);
    }
  };

  const data = query.data;
  if (query.isError && !data)
    return (
      <section className="border-t border-secondary px-6 py-5">
        <Alert color="error" description={m.agent_apps_load_error()} />
      </section>
    );
  if (!data?.enabled) return null;
  return (
    <section className="border-t border-secondary px-6 py-5">
      <div className="flex items-center gap-1.5">
        <p className={SECTION_CAPTION_CLASS}>{m.agent_app_events_section()}</p>
        <Badge size="sm" color="brand">
          {m.agent_app_events_experimental()}
        </Badge>
      </div>
      <p className="mt-1 text-sm text-tertiary">{m.agent_app_events_section_description()}</p>
      <p className="mt-1 text-sm text-tertiary">{m.agent_app_events_read_hint()}</p>
      {failure && (
        <div className="mt-3">
          <Alert color="error" description={failure} />
        </div>
      )}
      {data.pendingRequests.length > 0 && (
        <div className="mt-4">
          <p className="text-sm font-medium text-secondary">{m.agent_app_events_pending_title()}</p>
          <ul className="mt-2 space-y-3">
            {data.pendingRequests.map((request) => (
              <AppEventRow
                key={request.id}
                name={request.appName}
                logoUrl={request.appLogoUrl}
                time={request.createdAt}
                timeZone={timeZone}
                scopes={request.scopes}
                badge={
                  <BadgeWithDot size="sm" color="warning" type="pill-color">
                    {m.agent_apps_pending_badge()}
                  </BadgeWithDot>
                }
                actions={
                  data.canManage && (
                    <>
                      {(["approve", "deny"] as const).map((decision) => (
                        <Button
                          key={decision}
                          size="sm"
                          color={decision === "approve" ? "primary" : "secondary"}
                          isDisabled={busy !== undefined}
                          isLoading={busy === `${decision}:${request.id}`}
                          showTextWhileLoading
                          onPress={() =>
                            void act(
                              `${decision}:${request.id}`,
                              () => decide({ data: { agentId, requestId: request.id, decision } }),
                              decision === "approve"
                                ? m.agent_apps_approve_error()
                                : m.agent_apps_deny_error(),
                            )
                          }
                        >
                          {decision === "approve" ? m.agent_apps_approve() : m.agent_apps_deny()}
                        </Button>
                      ))}
                    </>
                  )
                }
              />
            ))}
          </ul>
        </div>
      )}
      <div className="mt-4">
        <p className="text-sm font-medium text-secondary">{m.agent_app_events_grants_title()}</p>
        {data.grants.length === 0 ? (
          <p className="mt-2 text-sm text-tertiary">{m.agent_app_events_grants_empty()}</p>
        ) : (
          <ul className="mt-2 space-y-3">
            {data.grants.map((grant) => (
              <AppEventRow
                key={grant.id}
                name={grant.appName}
                logoUrl={grant.appLogoUrl}
                time={grant.grantedAt}
                timeZone={timeZone}
                note={
                  grant.source === "automatic"
                    ? m.agent_app_events_source_automatic()
                    : m.agent_app_events_source_approval()
                }
                scopes={grant.scopes}
                badge={
                  <BadgeWithDot size="sm" color="success" type="pill-color">
                    {m.agent_apps_active()}
                  </BadgeWithDot>
                }
                actions={
                  data.canManage && (
                    <Button
                      size="sm"
                      color="secondary"
                      isDisabled={busy !== undefined}
                      isLoading={busy === `revoke:${grant.id}`}
                      showTextWhileLoading
                      onPress={() =>
                        void act(
                          `revoke:${grant.id}`,
                          () => revoke({ data: { agentId, grantId: grant.id } }),
                          m.agent_apps_revoke_error(),
                        )
                      }
                    >
                      {m.agent_apps_revoke()}
                    </Button>
                  )
                }
              />
            ))}
          </ul>
        )}
      </div>
      <div className="mt-4">
        <p className="text-sm font-medium text-secondary">{m.agent_app_events_recent_title()}</p>
        {data.events.length === 0 ? (
          <p className="mt-2 text-sm text-tertiary">{m.agent_app_events_recent_empty()}</p>
        ) : (
          <ul className="mt-2 space-y-3">
            {data.events.map((event) => (
              <EventRow key={event.id} event={event} timeZone={timeZone} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function AppEventRow({
  name,
  logoUrl,
  time,
  timeZone,
  note,
  scopes,
  badge,
  actions,
}: {
  name: string;
  logoUrl: string | null;
  time: string;
  timeZone: string | null;
  note?: string;
  scopes: string[];
  badge: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <li className="min-w-0 space-y-3 rounded-xl border border-secondary bg-primary p-4">
      <div className="flex items-start gap-3">
        <AppLogo name={name} url={logoUrl} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold break-words text-primary">{name}</p>
          <p className="font-mono text-xs text-tertiary">
            <RelativeTime value={time} timeZone={timeZone} showExact />
          </p>
          {note && <p className="text-xs text-tertiary">{note}</p>}
        </div>
        <span className="shrink-0">{badge}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {scopes.map((scope) => (
          <Badge key={scope} size="sm" color="gray" type="modern">
            <span className="font-mono">{scope}</span>
          </Badge>
        ))}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-x-3 gap-y-2">{actions}</div>}
    </li>
  );
}

/** One event: the app it came from, its kind and summary, and its payload as inert text. */
function EventRow({
  event,
  timeZone,
}: {
  event: AgentAppEvents["events"][number];
  timeZone: string | null;
}) {
  return (
    <li className="min-w-0 space-y-2 rounded-xl border border-secondary bg-primary p-4">
      <div className="flex items-start gap-3">
        <AppLogo name={event.appName} url={event.appLogoUrl} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold break-words text-primary">{event.appName}</p>
          <p className="font-mono text-xs text-tertiary">
            <RelativeTime value={event.createdAt} timeZone={timeZone} showExact />
          </p>
        </div>
        {event.expired && (
          <Badge size="sm" color="warning">
            {m.agent_app_events_expired()}
          </Badge>
        )}
        <Badge size="sm" color={event.kind === "event" ? "brand" : "gray"}>
          {event.kind === "event"
            ? m.agent_app_events_kind_event()
            : m.agent_app_events_kind_notification()}
        </Badge>
      </div>
      <p className="text-sm break-words whitespace-pre-line text-secondary">{event.summary}</p>
      {event.payloadText !== null && (
        <details>
          <summary className="cursor-pointer text-sm text-secondary">
            {m.agent_app_events_payload()}
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-secondary p-3 font-mono text-xs break-words whitespace-pre-wrap text-primary">
            {event.payloadText}
          </pre>
          <p className="mt-2 font-mono text-xs break-all text-tertiary">
            {m.agent_app_events_hash({ hash: event.payloadHash })}
          </p>
        </details>
      )}
      <p className="text-xs text-tertiary">
        {m.agent_app_events_expires()}{" "}
        <RelativeTime value={event.expiresAt} timeZone={timeZone} showExact />
      </p>
    </li>
  );
}
