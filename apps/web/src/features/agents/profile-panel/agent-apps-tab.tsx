import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { LinkExternal01 } from "@untitledui/icons";
import { Link as AriaLink } from "react-aria-components";

import { Badge, BadgeWithDot } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { RelativeTime } from "#src/components/ui/relative-time";
import { Skeleton } from "#src/components/ui/skeleton";
import type { AgentAppGrantSource } from "#src/features/apps/agent-app-access";
import {
  decideAgentAppRequest,
  grantAgentApp,
  loadAgentAppAccess,
  revokeAgentAppGrant,
  type AgentAppAccess,
} from "#src/features/agents/agent-apps.functions";
import { m } from "#src/paraglide/messages";
import { AppLogo } from "#src/features/apps/app-logo";
import { AgentAppGrantPanel } from "./agent-app-grant-panel";
import { AgentAppsEmpty } from "./agent-apps-empty";
import { SECTION_CAPTION_CLASS } from "./inline-edit-field";

const SOURCE_LABELS: Record<AgentAppGrantSource, () => string> = {
  person: m.agent_apps_source_person,
  automatic: m.agent_apps_source_automatic,
  approval: m.agent_apps_source_approval,
};

/**
 * The profile panel's Apps tab: the Agent's requests waiting for approval, and the apps it has
 * access to, with an inline panel to grant one more. Everyone who sees the Agent sees the tab; only
 * those who may change its app access (`canManage`) get Approve, Deny, Grant access and Revoke.
 * Every failure is shown inline at the top of the tab, as the reference does.
 */
export function AgentAppsTab({ agentId, timeZone }: { agentId: string; timeZone: string | null }) {
  const load = useServerFn(loadAgentAppAccess);
  const query = useQuery({
    queryKey: ["agent-app-access", agentId],
    queryFn: () => load({ data: { agentId } }),
  });
  const grant = useServerFn(grantAgentApp);
  const revoke = useServerFn(revokeAgentAppGrant);
  const decide = useServerFn(decideAgentAppRequest);
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [granting, setGranting] = useState(false);

  /** Runs one action at a time, then reads the tab again; a failure is shown at the top. */
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
  if (!data)
    return query.isError ? (
      <div className="px-6 py-5">
        <Alert
          color="error"
          description={m.agent_apps_load_error()}
          actions={
            <Button size="sm" color="secondary" onPress={() => void query.refetch()}>
              {m.agent_apps_retry()}
            </Button>
          }
        />
      </div>
    ) : (
      <div aria-busy="true" className="space-y-3 px-6 py-5">
        <p role="status" className="sr-only">
          {m.agent_apps_loading()}
        </p>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-24 w-full" />
      </div>
    );

  const granted = new Set(data.grants.map((item) => item.appKey));
  const grantable = data.apps.filter((app) => !granted.has(app.key));
  return (
    <div>
      {(failure || (query.isError && !query.isFetching)) && (
        <div className="px-6 pt-5">
          <Alert color="error" description={failure ?? m.agent_apps_load_error()} />
        </div>
      )}
      {data.pendingRequests.length > 0 && (
        <section className="border-b border-secondary px-6 py-5">
          <div className="flex items-center gap-1.5">
            <p className={SECTION_CAPTION_CLASS}>{m.agent_apps_pending_title()}</p>
            <Badge size="sm" color="gray">
              {data.pendingRequests.length}
            </Badge>
          </div>
          <ul className="mt-3 space-y-3">
            {data.pendingRequests.map((request) => (
              <AppRow
                key={request.id}
                name={request.appName}
                time={<RelativeTime value={request.createdAt} timeZone={timeZone} showExact />}
                badge={
                  <BadgeWithDot size="sm" color="warning" type="pill-color">
                    {m.agent_apps_pending_badge()}
                  </BadgeWithDot>
                }
                scopes={request.scopes}
                actions={
                  data.canManage && (
                    <>
                      <Button
                        size="sm"
                        color="primary"
                        isDisabled={busy !== undefined}
                        isLoading={busy === `approve:${request.id}`}
                        showTextWhileLoading
                        onPress={() =>
                          void act(
                            `approve:${request.id}`,
                            () =>
                              decide({
                                data: { agentId, requestId: request.id, decision: "approve" },
                              }),
                            m.agent_apps_approve_error(),
                          )
                        }
                      >
                        {m.agent_apps_approve()}
                      </Button>
                      <Button
                        size="sm"
                        color="secondary"
                        isDisabled={busy !== undefined}
                        isLoading={busy === `deny:${request.id}`}
                        showTextWhileLoading
                        onPress={() =>
                          void act(
                            `deny:${request.id}`,
                            () =>
                              decide({
                                data: { agentId, requestId: request.id, decision: "deny" },
                              }),
                            m.agent_apps_deny_error(),
                          )
                        }
                      >
                        {m.agent_apps_deny()}
                      </Button>
                    </>
                  )
                }
              />
            ))}
          </ul>
        </section>
      )}
      <section className="px-6 py-5">
        <div className="flex min-h-8 items-center justify-between gap-3">
          <p className={SECTION_CAPTION_CLASS}>{m.agent_apps_section()}</p>
          {data.canManage && !granting && (
            <Button size="sm" color="secondary" onPress={() => setGranting(true)}>
              {m.agent_apps_grant()}
            </Button>
          )}
        </div>
        <p className="mt-1 text-sm text-tertiary">{m.agent_apps_section_description()}</p>
        {granting && (
          <AgentAppGrantPanel
            apps={grantable}
            anyInstalled={data.apps.length > 0}
            onCancel={() => setGranting(false)}
            onGrant={async (appKey, scopes) => {
              await grant({ data: { agentId, appKey, scopes } });
              setGranting(false);
              await query.refetch();
            }}
          />
        )}
        {data.grants.length === 0 ? (
          <AgentAppsEmpty
            title={m.agent_apps_empty()}
            description={m.agent_apps_empty_description()}
          />
        ) : (
          <ul className="mt-4 space-y-3">
            {data.grants.map((item) => (
              <GrantRow
                key={item.id}
                grant={item}
                timeZone={timeZone}
                revoke={
                  data.canManage && (
                    <Button
                      size="sm"
                      color="secondary"
                      isDisabled={busy !== undefined}
                      isLoading={busy === `revoke:${item.id}`}
                      showTextWhileLoading
                      onPress={() =>
                        void act(
                          `revoke:${item.id}`,
                          () => revoke({ data: { agentId, grantId: item.id } }),
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
      </section>
    </div>
  );
}

function GrantRow({
  grant,
  timeZone,
  revoke,
}: {
  grant: AgentAppAccess["grants"][number];
  timeZone: string | null;
  revoke: ReactNode;
}) {
  const homepage = grant.homepageUrl === null ? null : new URL(grant.homepageUrl);
  return (
    <AppRow
      name={grant.appName}
      time={<RelativeTime value={grant.grantedAt} timeZone={timeZone} showExact />}
      source={SOURCE_LABELS[grant.source]()}
      badge={
        <BadgeWithDot size="sm" color="success" type="pill-color">
          {m.agent_apps_active()}
        </BadgeWithDot>
      }
      description={grant.appDescription}
      scopes={grant.scopes}
      actions={
        (revoke || homepage) && (
          <>
            {revoke}
            {homepage && (
              <AriaLink
                href={homepage.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-w-0 items-center gap-1 rounded-sm text-sm text-secondary outline-focus-ring hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <LinkExternal01 aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="underline underline-offset-4">{m.agent_apps_homepage()}</span>
              </AriaLink>
            )}
          </>
        )
      }
    />
  );
}

/** One app on the tab: its name, time and status, what it is, its scopes and its actions. */
function AppRow({
  name,
  time,
  source,
  badge,
  description,
  scopes,
  actions,
}: {
  name: string;
  time: ReactNode;
  source?: string;
  badge: ReactNode;
  description?: string;
  scopes: string[];
  actions: ReactNode;
}) {
  return (
    <li className="min-w-0 space-y-3 rounded-xl border border-secondary bg-primary p-4">
      <div className="flex items-start gap-3">
        <AppLogo name={name} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold break-words text-primary">{name}</p>
          <p className="font-mono text-xs text-tertiary">{time}</p>
          {source && <p className="text-xs text-tertiary">{source}</p>}
        </div>
        <span className="shrink-0">{badge}</span>
      </div>
      {description && (
        <p className="text-sm break-words whitespace-pre-line text-secondary">{description}</p>
      )}
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
