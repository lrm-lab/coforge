import { Badge } from "#src/components/base/badges/badges";
import { m } from "#src/paraglide/messages";
import { AgentAccessScope } from "./agent-access-field";
import { InstallationCard } from "./app-editor-installation";
import { AppWebhookDelivery } from "./app-webhook-delivery";
import { InstallationApproval } from "./app-editor-permissions";
import { UninstallRow } from "./app-uninstall";
import { SetupStatusCard } from "./app-editor-setup";
import {
  AppDialogShell,
  DialogCloseButton,
  HomepageLink,
  LoginScopeList,
} from "./app-dialog-parts";
import { resolveAgentManifest } from "./app-agent-manifest";
import type { AppDeclarations, AppSummary } from "./apps.functions";

/**
 * The detail of an installed app, read-only for every role: who it is, what it does, the scopes
 * Login with CoForge lets it ask for, which Agents may use it (an owner or admin changes that
 * here) and, where their flags are on (`declares`), its setup status and the data it reads. An
 * owner or admin (`canManage`) also continues setup, approves a pending permissions update and
 * sees the installation ID; a member is told to ask one. Editing the app is the editor's, behind
 * the card's Edit button.
 */
export function AppDetail({
  open,
  app,
  declares,
  canManage,
  onClose,
  onApprovePermissions,
  onRefreshSetup,
  onUninstall,
}: {
  open: boolean;
  /** The app as the list now holds it; kept while the dialog fades out. */
  app: AppSummary | undefined;
  declares: AppDeclarations;
  /** An owner or admin: may continue setup, approve a pending update and see the installation ID. */
  canManage: boolean;
  onClose: () => void;
  /** Approves the app's saved permissions at `revision`, the one shown. Throws when refused. */
  onApprovePermissions: (app: AppSummary, revision: number) => Promise<void>;
  /** Reads the apps again for the installation's setup status; throws when it can't. */
  onRefreshSetup: () => Promise<void>;
  /** Uninstalls an app another Workspace owns; throws when refused. */
  onUninstall: (app: AppSummary) => Promise<void>;
}) {
  const homepage = app?.homepageUrl ? new URL(app.homepageUrl) : null;
  const manifest = app && declares.manifest ? resolveAgentManifest(app) : null;
  const permissions = app?.permissions;
  const setup = app?.setup;
  const installationId = permissions?.installationId ?? setup?.installation?.installationId;
  return (
    <AppDialogShell
      open={open}
      onClose={onClose}
      eyebrow={m.apps_detail_eyebrow()}
      app={app}
      badges={
        app && (
          <Badge size="sm" color="gray">
            {app.owned
              ? m.apps_this_workspace()
              : m.apps_by_developer({ developer: app.developer })}
          </Badge>
        )
      }
      footer={<DialogCloseButton label={m.controls_close()} onClose={onClose} />}
    >
      {app && (
        <>
          <p className="text-sm wrap-anywhere whitespace-pre-line text-secondary">
            {app.description || m.apps_detail_no_description()}
          </p>
          {app.ownerAgent && (
            <p className="text-sm text-tertiary">
              {m.apps_detail_owner_agent({ agent: app.ownerAgent.name })}
            </p>
          )}
          {homepage && (
            <div className="grid gap-1">
              <p className="text-sm text-tertiary">{m.apps_detail_homepage()}</p>
              <HomepageLink href={homepage.href} host={homepage.host} />
            </div>
          )}
          {manifest?.agentManifestUrl && (
            <div className="grid gap-1">
              <p className="text-sm text-tertiary">{m.apps_detail_agent_manifest()}</p>
              <p className="font-mono text-xs wrap-anywhere text-secondary">
                {manifest.agentManifestUrl}
              </p>
              {manifest.agentManifestUrlSource === "well_known" && (
                <p className="text-xs text-tertiary">{m.apps_detail_agent_manifest_derived()}</p>
              )}
            </div>
          )}
          <section className="grid gap-2">
            <h3 className="text-sm font-semibold text-primary">{m.apps_section_login()}</h3>
            <p className="text-sm text-tertiary">{m.apps_detail_login_summary()}</p>
            <LoginScopeList allowedScopes={app.allowedScopes} />
          </section>
          <AgentAccessScope appKey={app.key} canManage={canManage} />
          {declares.setup && setup?.installation && (
            <SetupStatusCard
              installation={setup.installation}
              url={setup.url}
              description={setup.description}
              canManage={canManage}
              onRefresh={onRefreshSetup}
            />
          )}
          {declares.permissions && permissions && (
            <section className="grid gap-2">
              <h3 className="text-sm font-semibold text-primary">{m.apps_section_permissions()}</h3>
              <InstallationApproval
                permissions={permissions}
                canManage={canManage}
                onApprove={() => onApprovePermissions(app, permissions.revision)}
              />
            </section>
          )}
          {canManage && declares.notifications && app.owned && (
            <AppWebhookDelivery appKey={app.key} status={app.webhookStatus} />
          )}
          {canManage && installationId !== undefined && (
            <InstallationCard installationId={installationId} />
          )}
          {canManage && !app.owned && <UninstallRow app={app} onUninstall={onUninstall} />}
        </>
      )}
    </AppDialogShell>
  );
}
