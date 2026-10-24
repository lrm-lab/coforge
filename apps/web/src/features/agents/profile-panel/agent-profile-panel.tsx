import { useCallback, useEffect, useEffectEvent, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { Edit01 as Pencil } from "@untitledui/icons";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { isAppErrorCode } from "#src/lib/app-error";
import { m } from "#src/paraglide/messages";
import { useSubmitGuard } from "#src/hooks/use-submit-guard";
import {
  useLiveAgent,
  usePrefetchAgentActivityFeed,
} from "#src/features/agents/workspace-agents-realtime";
import { agentDisplay } from "#src/features/agents/agent-activity-presentation";
import { AgentReminders } from "#src/features/agents/agent-reminders";
import { listAgentReminders } from "#src/features/agents/agent-reminders.functions";
import { getAgentSkills } from "#src/features/agents/agent-skills.functions";
import {
  listAgentWorkspaceFiles,
  readAgentWorkspaceFile,
} from "#src/features/agents/agent-workspace-files.functions";
import { useAgentRuntimeControls } from "#src/features/agents/agent-runtime-controls";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { executeAgentControl } from "#src/features/agents/agent-control.functions";
import { AgentControlDialogs } from "#src/features/agents/agent-control-dialogs";
import { AgentRuntimeCredentialDialog } from "#src/features/agents/agent-runtime-credential-dialog";
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
  setAgentMascot,
  updateAgentRole,
  saveAgentRuntimeCredential,
  deleteAgentRuntimeCredential,
  saveAgentEnvironment,
  deleteAgent,
  changeAgentVisibility,
  previewAgentVisibilityChange,
} from "#src/features/agents/agents.functions";
import { AgentDeleteDialog } from "#src/features/agents/agent-delete-dialog";
import { AgentArchiveSection } from "./agent-archive-section";
import { AgentMigrationSection } from "./agent-migration-section";
import { AgentVisibilityConfirmDialog } from "#src/features/agents/agent-visibility-confirm-dialog";
import type { AgentVisibility } from "#src/features/agents/agent-visibility";
import { useAppToast } from "#src/components/ui/toast";
import { humanLabel } from "#src/lib/human-label";
import { agentModelsQueryKey } from "#src/features/agents/agent-models";
import { useCurrentWorkspaceId } from "#src/features/agents/workspace-agents-realtime";
import { AgentProfileHeader } from "./agent-profile-header";
import { AgentProfileUnavailable } from "./agent-profile-unavailable";
import { AgentProfileTabs, useAgentProfileTabOrder } from "./agent-profile-tabs";
import { setupComputerOptions } from "./setup-computers";
import { AgentProfileTab } from "./agent-profile-tab";
import { profileRuntimeSelection, profileUpdateInput } from "./agent-profile-runtime";
import { AgentWorkspaceTab } from "./agent-workspace-tab";
import { AgentActivityTab } from "./agent-activity-tab";
import { AgentAppsTab } from "./agent-apps-tab";
import { AgentProfileSkeleton } from "./agent-profile-skeleton";
import { AgentErrorBanner } from "./agent-error-banner";
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

/**
 * An Agent's profile: the conversation's right-hand slot content when it is the visible panel,
 * and a page of the channel settings sheet (with `back`) opened from its members. Same
 * chrome as the Thread panel (48px header band, 44px tab band, flat body, no page-level card),
 * built from `getAgentProfile` plus the existing workspace realtime hooks for live status/activity
 * — never its own subscription (`src/features/agents/AGENTS.md`'s Agent-state rule).
 */
export function AgentProfilePanel({
  agentId,
  requestedTab,
  onTabChange,
  onClose,
  back,
}: {
  agentId: string;
  requestedTab: ProfileTabId | undefined;
  onTabChange: (tab: ProfileTabId) => void;
  onClose: () => void;
  /** Shown inside another page: its Back button (see `AgentProfileHeader`). */
  back?: { label: string; onPress: () => void };
}) {
  const timeZone = appRoute.useLoaderData().timeZone;
  const router = useRouter();
  // Escape closes the panel, like Thread's Close; an open overlay or a field being edited keeps it.
  // An effect event, so a caller's fresh `onClose` each render does not re-add the listener.
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("input, textarea, [contenteditable=true]")) return;
    if (document.querySelector("[role=dialog], [role=alertdialog], [role=listbox], [role=menu]"))
      return;
    onClose();
  });
  useEffect(() => {
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  const liveAgent = useLiveAgent(agentId);
  const query = useQuery(agentProfileQuery(agentId));
  const profile = query.data;
  const invalidate = useInvalidateAgentProfile(agentId);
  // `liveAgent` (the shared realtime roster) is blank for an Agent outside the viewer's own
  // `listAgents` roster until its first live publication arrives, e.g. an owner/admin's
  // placeholder for another member's private Agent. `getAgentProfile` (this panel's authorized
  // fetch) already computes an initial display snapshot for any Agent the viewer can see;
  // prefer the live one once a publication lands, but seed from that fetch, not nothing.
  const display = liveAgent?.display ?? profile?.display;

  const knownName = profile?.displayName ?? liveAgent?.displayName ?? "";
  // A deleted Agent's profile is read-only: the Profile tab alone, nothing acting on it.
  const deleted = Boolean(profile?.deletedAt);
  const canManage = profile && !deleted ? canManageAgent(profile) : false;
  usePrefetchAgentActivityFeed(agentId, canManage);
  const owned = Boolean(profile?.ownedByCurrentUser) && !deleted;
  const loadComputers = useServerFn(listComputers);
  // An unbound Agent needs a Computer before its runtime can be saved; once bound, only
  // "Move to another Computer" changes it.
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
  );
  const tab = resolveAgentProfileTab(requestedTab, tabOrder.tabs);
  // Opened without `agentTab`, the panel lands on the first tab of the viewer's order once their
  // permissions are known, and records it through `onTabChange` (the URL, or the embedding page's
  // state) so a later reorder does not move it.
  const loaded = Boolean(profile);
  useEffect(() => {
    if (loaded && !requestedTab) onTabChange(tab);
  }, [loaded, requestedTab, tab, onTabChange]);

  const loadReminders = useServerFn(listAgentReminders);
  const onLoadReminders = useCallback(
    (cursor?: { id: string }) =>
      loadReminders({ data: { agentId, ...(cursor ? { cursor } : {}) } }),
    [agentId, loadReminders],
  );

  const loadSkills = useServerFn(getAgentSkills);
  const onLoadSkills = useCallback(() => loadSkills({ data: agentId }), [agentId, loadSkills]);

  const listWorkspaceFiles = useServerFn(listAgentWorkspaceFiles);
  const onListWorkspaceDir = useCallback(
    (dirPath: string, includeHidden: boolean) =>
      listWorkspaceFiles({ data: { agentId, dirPath, includeHidden } }),
    [agentId, listWorkspaceFiles],
  );
  const readWorkspaceFile = useServerFn(readAgentWorkspaceFile);
  const onReadWorkspaceFile = useCallback(
    (path: string) => readWorkspaceFile({ data: { agentId, path } }),
    [agentId, readWorkspaceFile],
  );

  // Owner-only env, for the Runtime config dialog.
  const queryClient = useQueryClient();
  const workspaceId = useCurrentWorkspaceId();
  const envQuery = useQuery(agentEnvironmentQuery(agentId, owned));
  const saveEnvironment = useServerFn(saveAgentEnvironment);
  const environmentState: AgentEnvironmentState | undefined = owned
    ? { loaded: envQuery.isSuccess, values: envQuery.data ?? {} }
    : undefined;

  const executeControl = useServerFn(executeAgentControl);
  const controls = useAgentRuntimeControls({
    agentId,
    agentName: knownName || agentId,
    canFullReset: profile?.canFullResetAgent ?? false,
    isOnline: agentDisplay(display, { stopped: profile?.stopped }).isOnline,
    computerOnline: profile?.computer?.online,
    computerLabel: profile?.computer?.label,
    onExecute: async (request) => {
      await executeControl({ data: request });
      await invalidate();
    },
  });

  const update = useServerFn(updateAgent);
  const pickMascot = useServerFn(setAgentMascot);
  const updateRole = useServerFn(updateAgentRole);
  const saveCredential = useServerFn(saveAgentRuntimeCredential);
  const deleteCredential = useServerFn(deleteAgentRuntimeCredential);
  const removeAgent = useServerFn(deleteAgent);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const changeVisibility = useServerFn(changeAgentVisibility);
  const loadVisibilityPreview = useServerFn(previewAgentVisibilityChange);
  const [visibilityTarget, setVisibilityTarget] = useState<AgentVisibility | null>(null);
  const toast = useAppToast();
  const [runtimeDialogOpen, setRuntimeDialogOpen] = useState(false);
  const [runtimeSaving, guardRuntime] = useSubmitGuard();
  const [runtimeError, setRuntimeError] = useState("");
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
  // Reuses the full page's edit-dialog submit path (`updateAgentInputFromForm` +
  // `agentUpdateErrorMessage`, `agent-form.ts`) so the two Runtime config editors never drift.
  // The panel's form carries only the runtime fields, so displayName/description are supplied
  // as fallbacks — never blanked by this save. Env rows are a second, independent save
  // (`saveAgentEnvironment`) gated by the form's own `changed.environment` flag, since Save can
  // fire with only one of the two actually different from what loaded.
  function onSaveRuntime(form: FormData, changed: { runtime: boolean; environment: boolean }) {
    void guardRuntimeForm(async () => {
      if (!profile) return;
      setRuntimeFormError("");
      try {
        if (changed.runtime)
          await update({
            data: updateAgentInputFromForm(form, {
              agentId: profile.id,
              computerId: profile.computer?.id,
              displayName: profile.displayName,
              description: profile.description ?? "",
            }),
          });
        if (changed.environment && profile.ownedByCurrentUser)
          await saveEnvironment({
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
      } catch (cause) {
        setRuntimeFormError(agentUpdateErrorMessage(cause));
      }
    });
  }

  if (query.isError) {
    // An Agent that exists but is private to someone else answers a distinct, detail-
    // free state — no "you may not have access, or it was removed" guess, just the one fact.
    const notVisible = isAppErrorCode(query.error, "AGENT_NOT_VISIBLE");
    return <AgentProfileUnavailable notVisible={notVisible} back={back} onClose={onClose} />;
  }

  const diagnosticFacts = profile && {
    id: profile.id,
    workspaceId: profile.workspaceId,
    computerId: profile.computerId ?? null,
    computerVersion: profile.computer?.computerVersion ?? null,
    runtime: profile.runtimeConfig.runtime,
    model: profile.runtimeConfig.model,
    stopped: profile.stopped,
    status: profile.status.value,
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <AgentProfileHeader
        canMessage={Boolean(profile?.canMessage)}
        deleted={deleted}
        agent={{
          id: agentId,
          displayName: knownName,
          avatarUrl: profile?.avatarUrl,
        }}
        mascot={profile?.mascot}
        appBot={Boolean(profile?.appBot)}
        display={display}
        controls={controls}
        onClose={onClose}
        back={back}
      />
      {diagnosticFacts && !deleted && display?.activityKind === "error" && (
        <AgentErrorBanner
          agent={diagnosticFacts}
          display={display}
          onActivityTab={tab === "activity"}
          onViewLogs={
            tabOrder.tabs.includes("activity") ? () => onTabChange("activity") : undefined
          }
        />
      )}
      <AgentProfileTabs
        active={tab}
        tabs={tabOrder.tabs}
        onSelect={onTabChange}
        onReorder={tabOrder.reorder}
      />
      {/* Workspace and Activity scroll their own parts. */}
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
            // Realtime once a display snapshot has arrived, the initial `getAgentProfile` load
            // until then — trusting the live display's own (possibly explicitly null)
            // `contextUsage` once present, never falling back past it to a stale initial read.
            contextUsage={display?.contextUsage ?? null}
            fastMode={display?.fastMode ?? null}
            onSaveDisplayName={async (value) => {
              await update({ data: baseUpdateInput({ displayName: value }) });
              await invalidate();
            }}
            onSaveDescription={async (value) => {
              await update({ data: baseUpdateInput({ description: value }) });
              await invalidate();
            }}
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
                  deletedBy={profile.deletedBy?.label ?? null}
                  computer={profile.computer}
                  canManageWorkspace={
                    Boolean(profile.computer?.ownedByViewer) || profile.canManageAgentRole
                  }
                  timeZone={timeZone}
                />
              ) : undefined
            }
            migration={
              profile.computer && !deleted ? (
                <AgentMigrationSection
                  agentId={profile.id}
                  agentName={profile.displayName || profile.name}
                  currentComputerId={profile.computer.id}
                  canMove={canManage}
                  runtime={profile.runtimeConfig.runtime}
                  model={profile.runtimeConfig.model}
                />
              ) : undefined
            }
            onRequestVisibilityChange={
              profile.canChangeVisibility ? (target) => setVisibilityTarget(target) : undefined
            }
            runtimeCredentialDialog={
              owned && profile.runtimeConfig.provider.kind === "coforge" ? (
                <>
                  <ButtonUtility
                    aria-label={m.agent_runtime_edit()}
                    tooltip={m.agent_runtime_edit()}
                    icon={Pencil}
                    size="xs"
                    color="tertiary"
                    onClick={() => {
                      setRuntimeError("");
                      setRuntimeDialogOpen(true);
                    }}
                  />
                  {runtimeDialogOpen && (
                    <AgentRuntimeCredentialDialog
                      open={runtimeDialogOpen}
                      onOpenChange={setRuntimeDialogOpen}
                      saving={runtimeSaving}
                      runtimeLabel={runtimeProviderLabel(profile.runtimeConfig.runtime)}
                      providerId={
                        profile.runtimeConfig.provider.kind === "coforge"
                          ? profile.runtimeConfig.provider.providerId
                          : ""
                      }
                      credentialHint={profile.runtimeCredential?.hint}
                      error={runtimeError}
                      modelFields={[
                        {
                          label: m.agent_form_model(),
                          value: profile.runtimeConfig.model || m.agent_form_provider_default(),
                        },
                        {
                          label: m.agent_form_reasoning(),
                          value: profile.runtimeConfig.reasoning || m.agent_form_provider_default(),
                        },
                      ]}
                      onSave={(apiKey) =>
                        guardRuntime(async () => {
                          setRuntimeError("");
                          try {
                            await saveCredential({ data: { agentId, apiKey } });
                            setRuntimeDialogOpen(false);
                            await invalidate();
                          } catch {
                            setRuntimeError(m.agent_runtime_save_error());
                          }
                        })
                      }
                      onDelete={
                        profile.runtimeCredential
                          ? () =>
                              guardRuntime(async () => {
                                setRuntimeError("");
                                try {
                                  await deleteCredential({ data: agentId });
                                  setRuntimeDialogOpen(false);
                                  await invalidate();
                                } catch {
                                  setRuntimeError(m.agent_runtime_delete_error());
                                }
                              })
                          : undefined
                      }
                    />
                  )}
                </>
              ) : null
            }
          />
        )}
      </div>
      {profile && (
        <AgentRuntimeConfigDialog
          open={runtimeEditing}
          onClose={onCancelRuntimeEdit}
          computerId={profile.computer?.id ?? ""}
          computers={setupComputers}
          credentialConfigured={Boolean(profile.runtimeCredential)}
          initial={profileRuntimeSelection(profile)}
          onLoad={onLoadRuntimeOptions}
          environment={environmentState}
          saving={runtimeFormSaving}
          error={runtimeFormError}
          onSave={onSaveRuntime}
        />
      )}
      <AgentControlDialogs agentName={knownName} control={controls} />
      {profile && visibilityTarget && (
        <AgentVisibilityConfirmDialog
          agentName={profile.displayName || profile.name}
          creatorName={humanLabel(profile.owner)}
          viewerIsCreator={profile.ownedByCurrentUser}
          target={visibilityTarget}
          open={visibilityTarget !== null}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setVisibilityTarget(null);
          }}
          onLoadPreview={() => loadVisibilityPreview({ data: agentId })}
          onConfirm={async () => {
            await changeVisibility({ data: { agentId, visibility: visibilityTarget } });
            setVisibilityTarget(null);
            await invalidate();
            const displayName = profile.displayName || profile.name;
            toast.success(
              visibilityTarget === "private"
                ? m.agent_visibility_changed_private_toast({ name: displayName })
                : m.agent_visibility_changed_public_toast({ name: displayName }),
            );
          }}
        />
      )}
      {profile && (
        <AgentDeleteDialog
          agentName={profile.name}
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          onDelete={async (confirmation) => {
            // A protected Agent throws server-side (the dialog shows its own message), so reaching
            // here means the Agent really was deleted.
            await removeAgent({ data: { agentId, confirmation } });
            setDeleteDialogOpen(false);
            // The Agent is gone from every live view, so the panel has nothing left to show.
            onClose();
            await invalidate();
          }}
        />
      )}
    </div>
  );
}
