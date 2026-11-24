import { useCallback, useId, useRef, useState, type FormEvent } from "react";
import { Link, useBlocker, type ShouldBlockFn } from "@tanstack/react-router";
import { ArrowLeft } from "@untitledui/icons";

import { PhoneFormBar } from "#src/components/ui/phone-form-bar";
import { Button } from "#src/components/base/buttons/button";
import { Alert } from "#src/components/ui/alert";
import { UnsavedChangesDialog } from "#src/components/ui/unsaved-changes-dialog";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { DangerZoneRows } from "./app-editor-danger";
import { DistributionSection } from "./app-editor-distribution";
import {
  EditorSection,
  LoginFields,
  ProfileFields,
  whenToUseLength,
  type FieldErrors,
} from "./app-editor-fields";
import { EMPTY_APP_DRAFT, draftOf, inputOf, type AppDraft } from "./app-draft";
import {
  APP_FIELD_PROBLEMS,
  SETUP_FIELD_PROBLEMS,
  appFormProblem,
  type AppEditorSubmission,
} from "./app-form";
import { AppLogo } from "./app-logo";
import { BotSection } from "./app-editor-bot";
import { useActiveSection, type Section } from "./use-active-section";
import { AppLogoField } from "./app-logo-field";
import { InstallationCard } from "./app-editor-installation";
import { NotificationsSection, useNotificationEvents } from "./app-editor-notifications";
import { PermissionFields } from "./app-editor-permissions";
import { SetupSection, type SetupErrors } from "./app-editor-setup";
import { refusedSetupFields, setupDraftOf, setupInputOf, type SetupDraft } from "./app-setup-draft";
import { samePermissionGroups, type AppPermissionGroup } from "./app-permissions";
import { APP_WHEN_TO_USE_MAX_LENGTH, refusedAppFields } from "./app-registration";
import { AppSecretPanel, type IssuedSecret } from "./app-secret-panel";
import type { AppDeclarations, AppSummary } from "./apps.functions";
import { DialogAction, DialogActions, DialogCancel } from "#src/components/ui/dialog-actions";

export type AppEditorProps = {
  app?: AppSummary;
  declares: AppDeclarations;
  issued: IssuedSecret | null;
  onBack: () => void;
  onSubmit: (submission: AppEditorSubmission, releaseGuard: () => void) => Promise<void>;
  onRegenerate: (app: AppSummary) => Promise<void>;
  onDelete: (app: AppSummary, releaseGuard: () => void) => Promise<void>;
  onUploadLogo: (app: AppSummary, file: File) => Promise<void>;
  onResetLogo: (app: AppSummary) => Promise<void>;
  onApprovePermissions: (app: AppSummary, revision: number) => Promise<void>;
  onRefreshSetup: () => Promise<void>;
  onRequestPublish: (app: AppSummary) => Promise<void>;
  onWithdrawPublish: (app: AppSummary) => Promise<void>;
  onRequestUnpublish: (app: AppSummary) => Promise<void>;
};

const EMPTY_SETUP_DRAFT: SetupDraft = { required: false, url: "", description: "" };

export function AppEditor({
  app,
  declares,
  issued,
  onBack,
  onSubmit,
  onRegenerate,
  onDelete,
  onUploadLogo,
  onResetLogo,
  onApprovePermissions,
  onRefreshSetup,
  onRequestPublish,
  onWithdrawPublish,
  onRequestUnpublish,
}: AppEditorProps) {
  const workspaceSlug = useWorkspaceSlug();
  const [saving, guard] = useSubmitGuard();
  const editing = app !== undefined;
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<AppDraft>(() => (app ? draftOf(app) : EMPTY_APP_DRAFT));
  const permissions = app?.permissions;
  const [groups, setGroups] = useState<AppPermissionGroup[]>(() => permissions?.declared ?? []);
  const [shownRevision, setShownRevision] = useState(permissions?.revision);
  if (permissions && permissions.revision !== shownRevision) {
    setShownRevision(permissions.revision);
    setGroups(permissions.declared);
  }
  const notificationEvents = useNotificationEvents(permissions, groups);
  const [endpointDirty, setEndpointDirty] = useState(false);
  const setup = app?.setup;
  const [setupDraft, setSetupDraft] = useState<SetupDraft>(() =>
    setup ? setupDraftOf(setup) : EMPTY_SETUP_DRAFT,
  );
  const [setupErrors, setSetupErrors] = useState<SetupErrors>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const idPrefix = useId();
  const ids = {
    profile: `${idPrefix}profile`,
    login: `${idPrefix}login`,
    permissions: `${idPrefix}permissions`,
    notifications: `${idPrefix}notifications`,
    bot: `${idPrefix}bot`,
    setup: `${idPrefix}setup`,
    distribution: `${idPrefix}distribution`,
    danger: `${idPrefix}danger`,
  };
  const sections: Section[] = [
    { id: ids.profile, title: m.apps_section_profile() },
    { id: ids.login, title: m.apps_section_login() },
    ...(declares.setup ? [{ id: ids.setup, title: m.apps_section_setup() }] : []),
    ...(declares.permissions ? [{ id: ids.permissions, title: m.apps_section_permissions() }] : []),
    ...(declares.notifications
      ? [{ id: ids.notifications, title: m.apps_notifications_section() }]
      : []),
    ...(declares.bot ? [{ id: ids.bot, title: m.apps_bot_section() }] : []),
    ...(editing ? [{ id: ids.distribution, title: m.apps_section_distribution() }] : []),
    ...(editing ? [{ id: ids.danger, title: m.apps_section_danger() }] : []),
  ];
  const [active, setActive] = useActiveSection(scroller, sections);
  const reducedMotion = usePrefersReducedMotion();
  const tooLong = whenToUseLength(draft) > APP_WHEN_TO_USE_MAX_LENGTH;
  const snapshot = () =>
    JSON.stringify({
      draft,
      setup: setupDraft,
      ...(permissions
        ? {}
        : { groups: [...groups].sort(), events: [...notificationEvents.submitted].sort() }),
    });
  const [baseline, setBaseline] = useState(snapshot);
  const dirty =
    endpointDirty ||
    snapshot() !== baseline ||
    (permissions !== undefined &&
      (!samePermissionGroups(groups, permissions.declared) || notificationEvents.unsaved));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const releaseGuard = useCallback(() => {
    dirtyRef.current = false;
  }, []);
  const shouldBlock = useCallback<ShouldBlockFn>(({ current, next }) => {
    if (!dirtyRef.current) return false;
    return next.pathname !== current.pathname;
  }, []);
  const shouldBeforeUnload = useCallback(() => dirtyRef.current, []);
  const blocker = useBlocker({
    shouldBlockFn: shouldBlock,
    enableBeforeUnload: shouldBeforeUnload,
    withResolver: true,
  });

  function change<Field extends keyof AppDraft>(field: Field, value: AppDraft[Field]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void guard(async () => void (await save(false)));
  }

  async function save(stayOpen: boolean): Promise<boolean> {
    setFormError("");
    const input = inputOf(draft);
    const { key, ...rest } = input;
    const refused = refusedAppFields(editing || key === "" ? rest : input);
    const setupRefused = declares.setup ? refusedSetupFields(setupDraft) : [];
    if (refused.length > 0 || setupRefused.length > 0) {
      setErrors(Object.fromEntries(refused.map((field) => [field, APP_FIELD_PROBLEMS[field]()])));
      setSetupErrors(
        Object.fromEntries(setupRefused.map((field) => [field, SETUP_FIELD_PROBLEMS[field]()])),
      );
      return false;
    }
    setSetupErrors({});
    try {
      await onSubmit(
        {
          input,
          permissionGroups: declares.permissions ? groups : undefined,
          notificationEvents: declares.notifications ? notificationEvents.submitted : undefined,
          setup: declares.setup ? setupInputOf(setupDraft) : undefined,
          stayOpen,
        },
        releaseGuard,
      );
      setBaseline(snapshot());
      return true;
    } catch (cause) {
      const problem = appFormProblem(cause, editing ? m.apps_error_update : m.apps_error_register);
      if (problem.setupField) setSetupErrors({ [problem.setupField]: problem.message });
      else if (problem.field) setErrors({ [problem.field]: problem.message });
      else setFormError(problem.message);
      return false;
    }
  }

  async function saveThenRequestPublish(current: AppSummary) {
    let saved = false;
    await guard(async () => void (saved = await save(true)));
    if (saved) await onRequestPublish(current);
  }

  const profileComplete = [draft.name, draft.description, draft.homepageUrl].every(
    (value) => value.trim() !== "",
  );
  const hasRedirect = draft.redirectUris.some((uri) => uri.trim() !== "");
  const fields = { draft, change, errors, editing };
  const installationId = permissions?.installationId ?? setup?.installation?.installationId;
  const installationCard = installationId !== undefined && (
    <InstallationCard installationId={installationId} />
  );
  const heading = editing ? m.apps_edit_title({ name: app.name }) : m.apps_register_title();

  return (
    <main className="flex h-full min-h-0 flex-1 flex-col bg-primary">
      <form ref={formRef} noValidate onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <PhoneFormBar
          heading={heading}
          submitLabel={editing ? m.apps_save() : m.apps_register_short()}
          pending={saving}
          submitDisabled={tooLong}
          onCancel={onBack}
          onSubmit={() => formRef.current?.requestSubmit()}
        />
        <header className="grid shrink-0 gap-2 border-b border-secondary px-6 py-4 max-sm:hidden">
          <Link
            to="/w/$workspaceSlug/settings"
            params={{ workspaceSlug }}
            search={{ section: "applications", appsTab: "mine" }}
            className="flex w-fit items-center gap-1 rounded-sm text-sm text-tertiary outline-focus-ring hover:text-primary focus-visible:outline-2"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            {m.apps_review_back()}
          </Link>
          <div className="flex items-center gap-3">
            <AppLogo name={draft.name || "?"} url={app?.logoUrl} size="sm" />
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-primary">
              {heading}
            </h1>
          </div>
        </header>
        {(formError || issued) && (
          <div className="grid shrink-0 gap-3 border-b border-secondary px-6 py-4">
            {formError && <Alert color="error" title={formError} />}
            {issued && <AppSecretPanel issued={issued} />}
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label={m.apps_editor_sections()}
            className="hidden w-44 shrink-0 border-r border-secondary p-3 md:block"
          >
            <ul className="grid gap-1">
              {sections.map((section) => (
                <li key={section.id}>
                  <Button
                    type="button"
                    color="tertiary"
                    size="sm"
                    aria-current={active === section.id ? "true" : undefined}
                    className={cn(
                      "w-full justify-start",
                      active === section.id && "bg-active text-brand-secondary",
                    )}
                    onPress={() => {
                      setActive(section.id);
                      document
                        .getElementById(section.id)
                        ?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth" });
                    }}
                  >
                    {section.title}
                  </Button>
                </li>
              ))}
            </ul>
          </nav>
          <div
            ref={scroller}
            className="min-h-0 flex-1 divide-y divide-secondary overflow-y-auto px-6"
          >
            <EditorSection
              id={ids.profile}
              title={m.apps_section_profile()}
              status={profileComplete ? m.apps_status_complete() : m.apps_status_needs_details()}
              description={m.apps_section_profile_description()}
            >
              <ProfileFields
                {...fields}
                logo={
                  <AppLogoField
                    name={draft.name}
                    isDisabled={saving}
                    logo={
                      app && {
                        url: app.logoUrl,
                        upload: (file) => onUploadLogo(app, file),
                        reset: () => onResetLogo(app),
                      }
                    }
                  />
                }
              />
            </EditorSection>
            <EditorSection
              id={ids.login}
              title={m.apps_section_login()}
              status={
                !hasRedirect
                  ? m.apps_status_not_configured()
                  : editing
                    ? m.apps_status_ready()
                    : m.apps_status_ready_to_save()
              }
              description={m.apps_section_login_description()}
            >
              <LoginFields {...fields} agentEvents={declares.agentEvents} />
            </EditorSection>
            {declares.setup && (
              <EditorSection
                id={ids.setup}
                title={m.apps_section_setup()}
                status={
                  setupDraft.required ? m.apps_setup_status_required() : m.apps_setup_status_none()
                }
                description={m.apps_section_setup_description()}
              >
                {installationCard}
                <SetupSection
                  draft={setupDraft}
                  setup={setup}
                  errors={setupErrors}
                  isDisabled={saving}
                  onChange={(next) => {
                    setSetupDraft(next);
                    setSetupErrors({});
                  }}
                  onRefresh={onRefreshSetup}
                />
              </EditorSection>
            )}
            {declares.permissions && (
              <EditorSection
                id={ids.permissions}
                title={m.apps_section_permissions()}
                status={m.apps_permissions_selected({ count: groups.length })}
                description={m.apps_section_permissions_description()}
              >
                {!declares.setup && installationCard}
                <PermissionFields
                  groups={groups}
                  permissions={permissions}
                  isDisabled={saving}
                  onChange={setGroups}
                  onApprove={async () => {
                    if (app && permissions)
                      await guard(() => onApprovePermissions(app, permissions.revision));
                  }}
                  installationShownAbove={declares.setup && installationId !== undefined}
                  eventsUnsaved={declares.notifications && notificationEvents.unsaved}
                />
              </EditorSection>
            )}
            {declares.notifications && (
              <NotificationsSection
                id={ids.notifications}
                appKey={app?.key}
                groups={groups}
                events={notificationEvents.events}
                isDisabled={saving}
                onEventsChange={notificationEvents.setEvents}
                onEndpointDirtyChange={setEndpointDirty}
              />
            )}
            {declares.bot && (
              <BotSection
                id={ids.bot}
                appKey={app?.key}
                declared={app?.enableBot ?? false}
                isDisabled={saving}
                onChanged={onRefreshSetup}
              />
            )}
            {app && (
              <DistributionSection
                id={ids.distribution}
                appKey={app.key}
                status={app.publishStatus ?? "private"}
                actions={{
                  requestPublish: () => saveThenRequestPublish(app),
                  withdraw: () => onWithdrawPublish(app),
                }}
              />
            )}
            {editing && (
              <EditorSection
                id={ids.danger}
                title={m.apps_section_danger()}
                status={m.apps_status_restricted()}
                description={m.apps_section_danger_description()}
              >
                <DangerZoneRows
                  app={app}
                  isDisabled={saving}
                  onRegenerate={() => onRegenerate(app)}
                  onDelete={() => onDelete(app, releaseGuard)}
                  onRequestUnpublish={() => onRequestUnpublish(app)}
                />
              </EditorSection>
            )}
          </div>
        </div>
        <DialogActions className="shrink-0 border-t border-secondary px-6 py-4 max-sm:hidden">
          <DialogCancel type="button" isDisabled={saving} onPress={onBack}>
            {m.controls_cancel()}
          </DialogCancel>
          <DialogAction
            type="submit"
            isDisabled={saving || tooLong}
            isLoading={saving}
            showTextWhileLoading
          >
            {saving ? m.apps_saving() : editing ? m.apps_save() : m.apps_register_submit()}
          </DialogAction>
        </DialogActions>
      </form>
      <UnsavedChangesDialog
        open={blocker.status === "blocked"}
        onKeepEditing={() => blocker.reset?.()}
        onDiscard={() => blocker.proceed?.()}
      />
    </main>
  );
}
