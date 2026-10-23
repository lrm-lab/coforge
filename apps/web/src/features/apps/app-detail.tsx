import { LinkExternal01, XClose } from "@untitledui/icons";
import { Heading, Link as AriaLink } from "react-aria-components";

import { Dialog, Modal, ModalOverlay } from "#src/components/application/modals/modal";
import { Button } from "#src/components/base/buttons/button";
import { Badge } from "#src/components/base/badges/badges";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { m } from "#src/paraglide/messages";
import { AgentAccessScope } from "./agent-access-field";
import { InstallationCard } from "./app-editor-installation";
import { AppWebhookDelivery } from "./app-webhook-delivery";
import { InstallationApproval } from "./app-editor-permissions";
import { SetupStatusCard } from "./app-editor-setup";
import { APP_SCOPE_DESCRIPTIONS } from "./app-form";
import { APP_CATEGORY_LABELS } from "./app-list";
import { AppLogo } from "./app-logo";
import { resolveAgentManifest } from "./app-agent-manifest";
import { appLoginScopes } from "./app-registration";
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
}) {
  const homepage = app?.homepageUrl ? new URL(app.homepageUrl) : null;
  const manifest = app && declares.manifest ? resolveAgentManifest(app) : null;
  const permissions = app?.permissions;
  const setup = app?.setup;
  const installationId = permissions?.installationId ?? setup?.installation?.installationId;
  return (
    <ModalOverlay isOpen={open} onOpenChange={(next) => !next && onClose()} isDismissable>
      <Modal className="w-[calc(100vw-2rem)] max-w-2xl">
        <Dialog className="flex max-h-[inherit] flex-col overflow-hidden text-left">
          {app && (
            <>
              <div className="flex shrink-0 items-start gap-3 border-b border-secondary px-6 py-4">
                <AppLogo name={app.name} url={app.logoUrl} size="md" />
                <div className="grid min-w-0 flex-1 gap-1">
                  <p className="text-xs font-medium text-tertiary">{m.apps_detail_eyebrow()}</p>
                  <Heading
                    slot="title"
                    className="text-lg font-semibold wrap-anywhere text-primary"
                  >
                    {app.name}
                  </Heading>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm text-tertiary">
                      {APP_CATEGORY_LABELS[app.category]()}
                    </span>
                    <Badge size="sm" color="gray">
                      {m.apps_this_workspace()}
                    </Badge>
                  </div>
                </div>
                <ButtonUtility
                  type="button"
                  aria-label={m.apps_detail_close()}
                  icon={XClose}
                  size="sm"
                  color="tertiary"
                  onClick={onClose}
                />
              </div>
              <div className="grid min-h-0 flex-1 content-start gap-5 overflow-x-hidden overflow-y-auto px-6 py-5 [&>*]:min-w-0">
                <p className="text-sm wrap-anywhere whitespace-pre-line text-secondary">
                  {app.description || m.apps_detail_no_description()}
                </p>
                {homepage && (
                  <div className="grid gap-1">
                    <p className="text-sm text-tertiary">{m.apps_detail_homepage()}</p>
                    <AriaLink
                      href={homepage.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex w-fit max-w-full items-center gap-1 rounded-sm text-sm text-secondary outline-focus-ring hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                      <LinkExternal01 aria-hidden="true" className="size-3.5 shrink-0" />
                      <span className="min-w-0 font-mono text-xs wrap-anywhere underline underline-offset-4">
                        {homepage.host}
                      </span>
                    </AriaLink>
                  </div>
                )}
                {manifest?.agentManifestUrl && (
                  <div className="grid gap-1">
                    <p className="text-sm text-tertiary">{m.apps_detail_agent_manifest()}</p>
                    <p className="font-mono text-xs wrap-anywhere text-secondary">
                      {manifest.agentManifestUrl}
                    </p>
                    {manifest.agentManifestUrlSource === "well_known" && (
                      <p className="text-xs text-tertiary">
                        {m.apps_detail_agent_manifest_derived()}
                      </p>
                    )}
                  </div>
                )}
                <section className="grid gap-2">
                  <h3 className="text-sm font-semibold text-primary">{m.apps_section_login()}</h3>
                  <p className="text-sm text-tertiary">{m.apps_detail_login_summary()}</p>
                  <ul className="grid gap-1.5">
                    {appLoginScopes(app.allowedScopes).map((scope) => (
                      <li key={scope} className="text-sm wrap-anywhere text-secondary">
                        <span className="font-mono">{scope}</span>
                        <span className="text-tertiary"> · {APP_SCOPE_DESCRIPTIONS[scope]()}</span>
                      </li>
                    ))}
                  </ul>
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
                    <h3 className="text-sm font-semibold text-primary">
                      {m.apps_section_permissions()}
                    </h3>
                    <InstallationApproval
                      permissions={permissions}
                      canManage={canManage}
                      onApprove={() => onApprovePermissions(app, permissions.revision)}
                    />
                  </section>
                )}
                {canManage && declares.notifications && (
                  <AppWebhookDelivery appKey={app.key} status={app.webhookStatus} />
                )}
                {canManage && installationId !== undefined && (
                  <InstallationCard installationId={installationId} />
                )}
              </div>
              <div className="flex shrink-0 justify-end border-t border-secondary px-6 py-4">
                <Button type="button" size="sm" color="secondary" onPress={onClose}>
                  {m.controls_close()}
                </Button>
              </div>
            </>
          )}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
