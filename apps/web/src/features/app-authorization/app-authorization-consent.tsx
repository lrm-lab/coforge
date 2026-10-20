import { LinkExternal01 } from "@untitledui/icons";
import { useState } from "react";

import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { HintText } from "#src/components/base/input/hint-text";
import { Select } from "#src/components/base/select/select";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { m } from "#src/paraglide/messages";
import type { AuthorizationPage } from "#src/server/authorization-server/authorization-endpoint.server";
import { AppLogo } from "#src/features/apps/app-logo";
import { decideAuthorization } from "./app-authorization.functions";

type ConsentPage = Extract<AuthorizationPage, { view: "consent" }>;

/** What each identity scope gives the app, in the order the page lists them. */
const IDENTITY_SCOPES: [scope: string, copy: () => string][] = [
  ["openid", m.app_authorization_scope_openid],
  ["profile", m.app_authorization_scope_profile],
  ["identity", m.app_authorization_scope_identity],
  ["email", m.app_authorization_scope_email],
];

/**
 * The consent for one request: the app, the Workspace to use it in (preselected when there is only
 * one), the access it asks for, and Continue or Cancel, which answer the request the page's handle
 * binds.
 */
export function AuthorizationConsent({
  page,
  account,
  onRefused,
}: {
  page: ConsentPage;
  account: string | null;
  onRefused: (page: AuthorizationPage) => void;
}) {
  const { app, workspaces, scopes, handle } = page;
  const [workspaceId, setWorkspaceId] = useState(workspaces.length === 1 ? workspaces[0]!.id : "");
  const [pending, guard] = useSubmitGuard();
  const [leaving, setLeaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const chosen = workspaces.find((workspace) => workspace.id === workspaceId);
  const listed = IDENTITY_SCOPES.filter(([scope]) => scopes.includes(scope));

  function decide(approve: boolean) {
    void guard(async () => {
      setFailed(false);
      try {
        const outcome = await decideAuthorization({
          data: {
            handle,
            decision: approve ? { approve: true, workspaceId } : { approve: false },
          },
        });
        if ("page" in outcome) return onRefused(outcome.page);
        setLeaving(true);
        window.location.assign(outcome.location);
      } catch {
        setFailed(true);
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1>
          <span className="block text-lg font-semibold break-words text-secondary">
            {m.app_authorization_connect_title({
              app: app.name,
              workspace: chosen?.name ?? m.app_authorization_this_workspace(),
            })}
          </span>
          <span className="mt-1 block text-display-sm font-semibold break-words text-primary">
            {app.name}
          </span>
        </h1>
        <p className="mt-3 text-md text-tertiary">
          {m.app_authorization_use_account({ app: app.name })}
        </p>
        {account === null ? null : (
          <p className="mt-2 text-xs break-all text-quaternary">
            {m.app_authorization_signed_in_as({ account })}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium text-secondary">{m.app_authorization_app_label()}</p>
        <div className="flex items-center gap-3 rounded-lg p-3 ring-1 ring-secondary">
          <AppLogo name={app.name} url={app.logoUrl} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 text-md font-semibold break-words text-primary">
                {app.name}
              </span>
              <Badge type="pill-color" color="success" size="sm">
                {m.app_authorization_app_installed()}
              </Badge>
            </div>
            {app.homepageUrl === null ? null : (
              <Button
                href={app.homepageUrl}
                target="_blank"
                rel="noopener noreferrer"
                color="link-color"
                size="sm"
                iconTrailing={LinkExternal01}
                aria-label={m.app_authorization_open_app({ app: app.name })}
                className="self-start break-all"
              >
                {app.homepageUrl}
              </Button>
            )}
          </div>
        </div>
        {app.homepageUrl === null ? null : (
          <p className="text-sm text-tertiary">{m.app_authorization_app_help()}</p>
        )}
      </div>

      <Select
        label={m.app_authorization_workspace_label()}
        hint={m.app_authorization_workspace_help()}
        placeholder={m.app_authorization_workspace_placeholder()}
        selectedKey={workspaceId || null}
        onSelectionChange={(key) => setWorkspaceId(key ? String(key) : "")}
        isDisabled={pending || leaving}
        hideRequiredIndicator
      >
        {workspaces.map((workspace) => (
          <Select.Item
            key={workspace.id}
            id={workspace.id}
            label={workspace.name}
            supportingText={workspace.slug}
          />
        ))}
      </Select>

      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-secondary">{m.app_authorization_access_label()}</p>
        <p className="text-sm text-tertiary">
          {m.app_authorization_access_intro({ app: app.name })}
        </p>
        <section className="mt-2 rounded-lg p-3 ring-1 ring-secondary">
          <h2 className="text-sm text-tertiary">
            <span className="font-semibold text-primary">
              {m.app_authorization_group_identity()}
            </span>
            {" — "}
            {m.app_authorization_group_identity_summary()}
          </h2>
          <ul className="mt-1 divide-y divide-secondary">
            {listed.map(([scope, copy]) => (
              <li key={scope} className="py-2">
                <code className="font-mono text-xs font-semibold text-primary">{scope}</code>
                <p className="mt-1 text-sm text-tertiary">{copy()}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button
            color="secondary"
            size="lg"
            isDisabled={pending || leaving}
            onPress={() => decide(false)}
          >
            {m.app_authorization_cancel()}
          </Button>
          <Button
            size="lg"
            isLoading={pending}
            isDisabled={leaving || !workspaceId}
            onPress={() => decide(true)}
          >
            {pending || leaving ? m.app_authorization_continuing() : m.app_authorization_continue()}
          </Button>
        </div>
        {failed ? (
          <HintText isInvalid role="alert">
            {m.app_authorization_failed()}
          </HintText>
        ) : null}
      </div>
    </div>
  );
}
