import { useEffect, useRef, useState } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { isAppErrorCode } from "#src/lib/app-error";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import {
  useLiveAgent,
  usePrefetchAgentActivityFeed,
} from "#src/features/agents/workspace-agents-realtime";
import { agentDisplay } from "#src/features/agents/agent-status-display";
import { AgentReminders } from "#src/features/agents/agent-reminders";
import { useAgentRuntimeControls } from "#src/features/agents/agent-runtime-controls";
import { executeAgentControl } from "#src/features/agents/agent-control.functions";
import { AgentRestartDialog } from "#src/features/agents/agent-control-dialogs";
import {
  AgentRuntimeConfigDialog,
  type AgentEnvironmentState,
} from "#src/features/agents/agent-runtime-config-dialog";
import { useAgentRuntimeOptionsLoader } from "#src/features/agents/agent-runtime-options";
import { listComputers } from "#src/features/computers/computers.functions";
import {
  agentUpdateErrorMessage,
  parseAgentEnvironmentFromForm,
  updateAgentInputFromForm,
} from "#src/features/agents/agent-form";
import {
  updateAgent,
  updateExternalAgentProfile,
  setAgentMascot,
  updateAgentRole,
  saveAgentEnvironment,
} from "#src/features/agents/agents.functions";
import { AgentArchiveSection } from "./agent-archive-section";
import { AgentMigrationSection } from "./agent-migration-section";
import { AlertTriangle } from "@untitledui/icons";
import { m } from "#src/paraglide/messages";
import { AgentRuntimeCredentialSection } from "./agent-runtime-credential-section";
import {
  combineRuntimeSaveOutcomes,
  useAgentRuntimeSaveNotice,
  type AgentRuntimeSaveOutcome,
} from "#src/features/agents/agent-runtime-save-notice";
import { AgentProfileConfirmationDialogs } from "./agent-profile-confirmation-dialogs";
import type { AgentVisibility } from "#src/features/agents/agent-visibility";
import { agentModelsQueryKey } from "#src/features/agents/agent-models";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { AgentProfileHeader } from "./agent-profile-header";
import { AgentProfileUnavailable } from "./agent-profile-unavailable";
import { AgentProfileTabs, useAgentProfileTabOrder } from "./agent-profile-tabs";
import { setupComputerOptions } from "./setup-computers";
import { AgentProfileTab } from "./agent-profile-tab";
import {
  agentMigrationRuntime,
  profileDiagnosticFacts,
  profileRuntimeSelection,
  profileUpdateInput,
} from "./agent-profile-runtime";
import { AgentWorkspaceTab } from "./agent-workspace-tab";
import { AgentActivityTab } from "./agent-activity-tab";
import { AgentAppsTab } from "./agent-apps-tab";
import { AgentChatTab } from "./agent-chat-tab";
import { useAgentPanelLoaders } from "./agent-profile-loaders";
import { AgentProfileSkeleton } from "./agent-profile-skeleton";
import { AgentProfileStatus } from "./agent-profile-status";
import type { AgentReadinessNoteData } from "./agent-readiness-note";
import { runtimeProviderLabel } from "../runtime-provider-display";
import { humanLabel } from "#src/lib/human-label";
import {
  resolveAgentProfileTab,
  type AgentProfileTab as ProfileTabId,
} from "./profile-panel-search";
import {
  agentEnvironmentKey,
  agentEnvironmentQuery,
  agentProfileQuery,
  canManageAgent,
  useInvalidateAgentProfile,
} from "./agent-profile-queries";

const appRoute = getRouteApi("/w/$workspaceSlug");

export function AgentProfilePanel({
  agentId,
  requestedTab,
  onTabChange,
  onClose,
  back,
  pageHeading,
}: {
  agentId: string;
  requestedTab: ProfileTabId | undefined;
  onTabChange: (tab: ProfileTabId) => void;
  onClose: () => void;
  back?: { label: string; onPress: () => void };
  pageHeading?: boolean;
}) {
  const timeZone = appRoute.useLoaderData().timeZone;
  const workspaceSlug = appRoute.useParams().workspaceSlug;
  const router = useRouter();
  const root = useRef<HTMLDivElement>(null);
  useHotkey(
    "Escape",
    () => {
      if (root.current?.offsetParent === null) return;
      if (document.querySelector(OPEN_OVERLAY_SELECTOR) === null) onClose();
    },
    { ignoreInputs: true, preventDefault: false },
  );
  const liveAgent = useLiveAgent(agentId);
  const query = useQuery(agentProfileQuery(agentId));
  const profile = query.data;
  const invalidate = useInvalidateAgentProfile(agentId);
  const display = liveAgent?.display ?? profile?.display;

  const knownName = profile?.displayName ?? liveAgent?.displayName ?? "";
  const deleted = Boolean(profile?.deletedAt);
  const canManage = profile && !deleted ? canManageAgent(profile) : false;
  usePrefetchAgentActivityFeed(agentId, canManage);
  const placeable = Boolean(
    profile &&
    canManage &&
    !deleted &&
    profile.systemKind == null &&
    profile.hosting !== "external" &&
    !profile.isWeeklyReportAssistant,
  );
  const owned = Boolean(profile?.ownedByCurrentUser) && !deleted;
  const migrationRuntime = agentMigrationRuntime(profile?.runtimeConfig);
  const loadComputers = useServerFn(listComputers);
  const offerComputerPicker = Boolean(profile && canManage && !profile.computer);
  const computersQuery = useQuery({
    queryKey: ["agent-runtime-computers", profile?.id, profile?.computerId ?? "none"],
    queryFn: () => loadComputers(),
    enabled: offerComputerPicker,
  });
  const setupComputers =
    offerComputerPicker && computersQuery.isSuccess
      ? setupComputerOptions(computersQuery.data ?? [], profile?.isWeeklyReportAssistant)
      : undefined;
  const tabOrder = useAgentProfileTabOrder(
    canManage,
    Boolean(profile) && !deleted && !profile?.appBot,
    Boolean(profile) && !deleted && (canManage || Boolean(profile?.appBot)),
  );
  const tab = resolveAgentProfileTab(requestedTab, tabOrder.tabs);
  const loaded = Boolean(profile);
  useEffect(() => {
    if (loaded && !requestedTab) onTabChange(tab);
  }, [loaded, requestedTab, tab, onTabChange]);

  const { onLoadReminders, onLoadSkills, onListWorkspaceDir, onReadWorkspaceFile } =
    useAgentPanelLoaders(agentId);

  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId();
  const envQuery = useQuery(agentEnvironmentQuery(agentId, owned));
  const saveEnvironment = useServerFn(saveAgentEnvironment);
  const environmentState: AgentEnvironmentState | undefined = owned
    ? { loaded: envQuery.isSuccess, values: envQuery.data ?? {} }
    : undefined;

  const executeControl = useServerFn(executeAgentControl);
  const agentIsOnline = agentDisplay(display, { stopped: profile?.stopped }).isOnline;
  const controls = useAgentRuntimeControls({
    agentId,
    agentName: knownName || agentId,
    canFullReset: profile?.canFullResetAgent ?? false,
    isOnline: agentIsOnline,
    computerOnline: profile?.computerAccessRevoked ? undefined : profile?.computer?.online,
    computerLabel: profile?.computer?.label,
    onExecute: async (request) => {
      await executeControl({ data: request });
      await invalidate();
    },
  });

  const notifyRuntimeSaved = useAgentRuntimeSaveNotice(agentId, controls, !deleted);
  const update = useServerFn(updateAgent);
  const updateExternal = useServerFn(updateExternalAgentProfile);
  const pickMascot = useServerFn(setAgentMascot);
  const updateRole = useServerFn(updateAgentRole);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [visibilityTarget, setVisibilityTarget] = useState<AgentVisibility | null>(null);
  const onLoadRuntimeOptions = useAgentRuntimeOptionsLoader();
  const [runtimeEditing, setRuntimeEditing] = useState(false);
  const [runtimeFormSaving, guardRuntimeForm] = useSubmitGuard();
  const [runtimeFormError, setRuntimeFormError] = useState("");

  function baseUpdateInput(overrides: { displayName?: string; description?: string }) {
    if (!profile) throw new Error("profile not loaded");
    return profileUpdateInput(profile, overrides);
  }

  function onStartRuntimeEdit() {
    setRuntimeFormError("");
    setRuntimeEditing(true);
  }
  function onCancelRuntimeEdit() {
    setRuntimeEditing(false);
    setRuntimeFormError("");
  }
  function onSaveRuntime(form: FormData, changed: { runtime: boolean; environment: boolean }) {
    void guardRuntimeForm(async () => {
      if (!profile) return;
      setRuntimeFormError("");
      try {
        let runtimeOutcome: AgentRuntimeSaveOutcome | undefined;
        let environmentOutcome: AgentRuntimeSaveOutcome | undefined;
        if (changed.runtime)
          runtimeOutcome = await update({
            data: updateAgentInputFromForm(form, {
              agentId: profile.id,
              computerId: profile.computer?.id,
              displayName: profile.displayName,
              description: profile.description ?? "",
            }),
          });
        if (changed.environment && profile.ownedByCurrentUser)
          environmentOutcome = await saveEnvironment({
            data: { agentId: profile.id, envVars: parseAgentEnvironmentFromForm(form) },
          });
        setRuntimeEditing(false);
        await Promise.all([
          invalidate(),
          queryClient.invalidateQueries({ queryKey: agentEnvironmentKey(profile.id) }),
          queryClient.invalidateQueries({ queryKey: agentModelsQueryKey(workspaceId) }),
          queryClient.invalidateQueries({
            queryKey: ["agent-runtime-computers", profile.id, profile.computerId ?? "none"],
          }),
        ]);
        notifyRuntimeSaved(combineRuntimeSaveOutcomes(runtimeOutcome, environmentOutcome));
      } catch (cause) {
        setRuntimeFormError(agentUpdateErrorMessage(cause));
      }
    });
  }

  if (query.isError) {
    const notVisible = isAppErrorCode(query.error, "AGENT_NOT_VISIBLE");
    return <AgentProfileUnavailable notVisible={notVisible} back={back} onClose={onClose} />;
  }

  const diagnosticFacts = profile && profileDiagnosticFacts(profile);
  const readinessData: AgentReadinessNoteData | undefined =
    profile && !deleted && profile.readiness.state !== "ready"
      ? {
          readiness: profile.readiness,
          computer: profile.computer
            ? {
                id: profile.computer.id,
                label: profile.computer.label,
                ownerLabel: profile.computer.ownerLabel,
                ownedByViewer: profile.computer.ownedByViewer,
              }
            : null,
          canManageAgentRole: profile.canManageAgentRole,
          canManageLogin: profile.canManageRuntimeLogin,
          canStartAgent: profile.canControlAgentRuntime,
          canManage,
          agentOwnerLabel: humanLabel(profile.owner),
          runtimeLabel: profile.runtimeConfig
            ? runtimeProviderLabel(profile.runtimeConfig.runtime)
            : "",
          workspaceSlug,
        }
      : undefined;

  return (
    <div ref={root} className="flex h-full min-h-0 min-w-0 flex-col">
      <AgentProfileHeader
        pageHeading={pageHeading}
        canMessage={Boolean(profile?.canMessage)}
        deleted={deleted}
        agent={{
          id: agentId,
          displayName: knownName,
          avatarUrl: profile?.avatarUrl ?? liveAgent?.avatarUrl,
          noIdDefault: !liveAgent,
        }}
        mascot={profile?.mascot ?? liveAgent?.mascot}
        appBot={Boolean(profile?.appBot)}
        display={display}
        controls={controls}
        onClose={onClose}
        back={back}
      />
      {profile?.computerAccessRevoked && !deleted ? (
        <p
          role="status"
          className="flex shrink-0 items-start gap-2 px-5 pb-2 text-sm text-secondary"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-warning-primary"
          />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {m.agent_migration_revoked_title({
              computer: profile.computer?.label || m.agent_computer_unnamed(),
            })}
          </span>
        </p>
      ) : (
        diagnosticFacts &&
        !deleted && (
          <AgentProfileStatus
            key={agentId}
            agent={diagnosticFacts}
            display={display}
            onActivityTab={tab === "activity"}
            retry={{
              onRetry: () => controls.submitStart(),
              onResetSession: () => controls.openRestart("reset-session"),
              busy: controls.startStopBusy,
              deferred: controls.startDeferred,
              note: controls.startNote,
              computerOffline: profile?.computer?.online === false,
            }}
            onViewLogs={
              tabOrder.tabs.includes("activity") ? () => onTabChange("activity") : undefined
            }
            wakeBlock={profile?.wakeBlock}
            readiness={readinessData}
            onOpenSettings={() => onTabChange("profile")}
          />
        )
      )}
      <AgentProfileTabs
        active={tab}
        tabs={tabOrder.tabs}
        onSelect={onTabChange}
        onReorder={tabOrder.reorder}
      />
      <div
        className={
          profile && (tab === "workspace" || tab === "activity")
            ? "flex min-h-0 flex-1 flex-col overflow-hidden"
            : "min-h-0 flex-1 overflow-y-auto"
        }
      >
        {!profile || !diagnosticFacts ? (
          <AgentProfileSkeleton />
        ) : tab === "activity" ? (
          <AgentActivityTab agent={diagnosticFacts} display={display} timeZone={timeZone} />
        ) : tab === "chat" ? (
          <AgentChatTab agentId={agentId} timeZone={timeZone} />
        ) : tab === "reminders" ? (
          <div className="px-5 pb-5">
            <AgentReminders
              agentId={agentId}
              canRead={canManage}
              timeZone={timeZone}
              onLoad={onLoadReminders}
            />
          </div>
        ) : tab === "apps" ? (
          <AgentAppsTab agentId={agentId} timeZone={timeZone} />
        ) : tab === "workspace" ? (
          <AgentWorkspaceTab
            agentId={agentId}
            onListDir={onListWorkspaceDir}
            onReadFile={onReadWorkspaceFile}
          />
        ) : (
          <AgentProfileTab
            profile={profile}
            timeZone={timeZone}
            canManage={canManage}
            controls={controls}
            contextUsage={display?.contextUsage ?? null}
            fastMode={display?.fastMode ?? null}
            onSaveDisplayName={async (value) => {
              if (profile.hosting === "external")
                await updateExternal({ data: { agentId, displayName: value } });
              else await update({ data: baseUpdateInput({ displayName: value }) });
              await invalidate();
            }}
            onSaveDescription={async (value) => {
              if (profile.hosting === "external")
                await updateExternal({ data: { agentId, description: value } });
              else await update({ data: baseUpdateInput({ description: value }) });
              await invalidate();
            }}
            onRefreshExternal={invalidate}
            onMascotChange={
              owned
                ? async (mascot) => {
                    await pickMascot({ data: { agentId, mascot } });
                    await invalidate();
                    await router.invalidate();
                  }
                : undefined
            }
            onSaveRole={
              profile.canManageAgentRole && !deleted
                ? async (role) => {
                    await updateRole({ data: { agentId, role } });
                    await invalidate();
                  }
                : undefined
            }
            onStartRuntimeEdit={onStartRuntimeEdit}
            onLoadSkills={owned ? onLoadSkills : undefined}
            onStartDelete={profile.canDeleteAgent ? () => setDeleteDialogOpen(true) : undefined}
            archive={
              profile.deletedAt && canManageAgent(profile) ? (
                <AgentArchiveSection
                  agentId={profile.id}
                  agentName={profile.displayName || profile.name}
                  deletedAt={profile.deletedAt}
                  deletedBy={profile.deletedBy}
                  computer={profile.computer}
                  canManageWorkspace={
                    Boolean(profile.computer?.ownedByViewer) || profile.canManageAgentRole
                  }
                  timeZone={timeZone}
                />
              ) : undefined
            }
            computerAccessRevoked={profile.computerAccessRevoked === true}
            migration={
              (profile.computer || placeable) && !deleted && migrationRuntime ? (
                <AgentMigrationSection
                  agentId={profile.id}
                  agentName={profile.displayName || profile.name}
                  currentComputerId={profile.computer?.id ?? null}
                  canMove={canManage}
                  runtime={migrationRuntime.runtime}
                  model={migrationRuntime.model}
                  agentOnline={agentIsOnline === true}
                />
              ) : undefined
            }
            onRequestVisibilityChange={
              profile.canChangeVisibility ? (target) => setVisibilityTarget(target) : undefined
            }
            runtimeCredentialDialog={
              owned ? (
                <AgentRuntimeCredentialSection
                  agentId={agentId}
                  runtimeConfig={profile.runtimeConfig}
                  runtimeCredential={profile.runtimeCredential}
                  notifySaved={notifyRuntimeSaved}
                />
              ) : null
            }
          />
        )}
      </div>
      {profile?.runtimeConfig && (
        <AgentRuntimeConfigDialog
          open={runtimeEditing}
          onClose={onCancelRuntimeEdit}
          computerId={profile.computer?.id ?? ""}
          computers={setupComputers}
          credentialConfigured={Boolean(profile.runtimeCredential)}
          initial={profileRuntimeSelection(profile.runtimeConfig)}
          onLoad={onLoadRuntimeOptions}
          environment={environmentState}
          saving={runtimeFormSaving}
          error={runtimeFormError}
          onSave={onSaveRuntime}
        />
      )}
      <AgentRestartDialog agentName={knownName} control={controls} />
      {profile && (
        <AgentProfileConfirmationDialogs
          profile={profile}
          agentId={agentId}
          visibilityTarget={visibilityTarget}
          setVisibilityTarget={setVisibilityTarget}
          deleteDialogOpen={deleteDialogOpen}
          setDeleteDialogOpen={setDeleteDialogOpen}
          onClose={onClose}
          invalidate={invalidate}
        />
      )}
    </div>
  );
}
