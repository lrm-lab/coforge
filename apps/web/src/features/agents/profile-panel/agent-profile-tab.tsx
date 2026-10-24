import { useState, type ComponentProps, type ReactNode } from "react";
import { DeletedAgentBadge } from "#src/features/agents/deleted-agent";
import {
  Camera01,
  Edit01,
  Play,
  RefreshCcw01 as RotateCcw,
  Stop,
  Archive,
} from "@untitledui/icons";
import { RUNTIME_PROVIDER, RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN } from "@lrm/coforge-sdk/internal";
import { AgentAvatarDialog } from "#src/features/agents/agent-avatar-dialog";
import type { AgentMascot } from "#src/features/agents/agent-mascot";
import { AgentMascotAvatar } from "#src/features/agents/agent-mascot-avatar";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { RelativeTime } from "#src/components/ui/relative-time";
import { StatusDot } from "#src/components/ui/status-dot";
import { humanLabel } from "#src/lib/human-label";
import { m } from "#src/paraglide/messages";
import { runtimeProviderLabel } from "#src/features/agents/runtime-provider-display";
import { RuntimeProviderMark } from "#src/features/agents/runtime-provider-mark";
import { AgentDesktopButton } from "#src/features/computers/agent-desktop-button";
import { computerIcon } from "#src/features/computers/computer-identity";
import { RuntimeUsage, UsageHealthDot } from "#src/features/computers/runtime-usage";
import type { AgentRuntimeControls } from "#src/features/agents/agent-runtime-controls";
import type { getAgentProfile } from "#src/features/agents/agents.functions";
import { AgentSkills, type AgentSkillsLoadResult } from "#src/features/agents/agent-skills";
import type { AgentVisibility } from "#src/features/agents/agent-visibility";
import { AgentContextSection } from "#src/features/agents/agent-context-popover";
import { useAgentContextReport } from "#src/features/agents/agent-context-report";
import { InlineEditField, SECTION_CAPTION_CLASS } from "./inline-edit-field";
import { AgentFastModeFact, type AgentFastModeReading } from "./agent-fast-mode-fact";
import { FactRow } from "./agent-fact-row";
import { AppBotProfile } from "./app-bot-profile";
import { RoleField, VisibilityField } from "./agent-profile-info-fields";
import { IdentityAvatar } from "#src/features/avatars/identity-avatar";

type AgentProfile = Awaited<ReturnType<typeof getAgentProfile>>;

/** The Runtime pill's trigger: a button with no chrome of its own, so the pill reads as one, and a
 * focus ring of its own for the keyboard. */
const RUNTIME_PILL_TRIGGER_CLASS =
  "inline-flex items-center gap-1.5 rounded-sm outline-none data-focus-visible:ring-2 data-focus-visible:ring-brand";

/** Gray badge for the runtime fact. */
function FactBadge({
  children,
  icon,
  mono = false,
}: {
  children: ReactNode;
  icon?: ReactNode;
  mono?: boolean;
}) {
  return (
    <Badge color="gray" size="md" className={`gap-1.5 font-medium ${mono ? "font-mono" : ""}`}>
      {icon}
      {children}
    </Badge>
  );
}

/**
 * The Agent profile panel's Profile tab body: INFO and RUNTIME CONFIG are one fact per row, a
 * fixed-width gray label on the left and the value on the right (`FactRow`), like the reference
 * Agent profile; no leading row icons. Managers/owners get the pencils, INFO's Role editor, RUNTIME CONFIG's credential
 * dialog and the ACTIONS section; everyone else sees a read-only Profile.
 */
export function AgentProfileTab(props: ComponentProps<typeof AgentProfileTabBody>) {
  const { profile, timeZone } = props;
  // An app's bot has no Computer or runtime to show or change.
  return profile.appBot ? (
    <AppBotProfile profile={{ ...profile, appBot: profile.appBot }} timeZone={timeZone} />
  ) : (
    <AgentProfileTabBody {...props} />
  );
}

function AgentProfileTabBody({
  profile,
  timeZone,
  canManage,
  controls,
  onSaveDisplayName,
  onSaveDescription,
  onMascotChange,
  onSaveRole,
  onRequestVisibilityChange,
  runtimeCredentialDialog,
  onStartRuntimeEdit,
  onLoadSkills,
  onStartDelete,
  migration,
  archive,
  contextUsage,
  fastMode,
}: {
  profile: NonNullable<AgentProfile>;
  timeZone: string | null;
  /** The Agent's current context-window usage, or `null` when there is no reading —
   * hidden entirely in that case. Display only: coloured by risk, but nothing triggers on it. */
  contextUsage?: {
    usedTokens: number;
    windowTokens: number;
    observedAtMs: number;
  } | null;
  /** What the launch actually observed for its Fast service tier, when the Agent asks for it. */
  fastMode?: AgentFastModeReading | null;
  /** The Agent's moves between Computers (`AgentMigrationSection`), shown under ACTIONS. */
  migration?: ReactNode;
  /** An archived Agent's ARCHIVE section (`AgentArchiveSection`), for those who managed it. */
  archive?: ReactNode;
  /** `canManageAgentRole || ownedByCurrentUser` — gates every pencil, the ACTIONS section. */
  canManage: boolean;
  controls: AgentRuntimeControls;
  onSaveDisplayName: (value: string) => Promise<void>;
  onSaveDescription: (value: string) => Promise<void>;
  /** Creator-only. Omitted for every other viewer, who still sees the picture. */
  onMascotChange?: (mascot: AgentMascot) => Promise<void>;
  onSaveRole?: (role: "admin" | "member") => Promise<void>;
  /** Opens the container's `AgentVisibilityConfirmDialog` for the given target visibility.
   * Present only for the creator or a human Workspace owner/admin. */
  onRequestVisibilityChange?: (target: AgentVisibility) => void;
  runtimeCredentialDialog: ReactNode;
  /** Opens the container's `AgentRuntimeConfigDialog` (see `agent-profile-panel.tsx`). The
   * RUNTIME CONFIG facts below never change; only the pencil does anything. */
  onStartRuntimeEdit?: () => void;
  /** Owner-only, same as the old Agent detail page's Skills section. Omitted for a viewer who
   * does not own the Agent. */
  onLoadSkills?: () => Promise<AgentSkillsLoadResult>;
  /** Opens the container's `AgentDeleteDialog`. Present only when the viewer holds
   * the `deleteAgents` capability and this Agent is a delete target at all. */
  onStartDelete?: () => void;
}) {
  const { runtime, model, reasoning } = profile.runtimeConfig;
  const canEditRuntime = canManage && Boolean(onStartRuntimeEdit);
  const runtimeLabel = runtimeProviderLabel(runtime);
  const runtimeIcon = <RuntimeProviderMark provider={runtime} className="size-3.5" />;
  const context = profile.deletedAt ? null : contextUsage;
  const usageComputer =
    profile.computer &&
    (context || (profile.runtimeUsageVisible && RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN[runtime]))
      ? profile.computer
      : undefined;
  const supportsContextReport = runtime === RUNTIME_PROVIDER.CLAUDE_CODE;
  // Read here, not in the card: the card mounts on every open, and the hook's
  // one-automatic-scan guard and in-flight scan must outlive it.
  const contextReport = useAgentContextReport(profile.id, {
    enabled: Boolean(context && usageComputer) && supportsContextReport,
    computerOnline: usageComputer?.online,
  });
  const creatorName = humanLabel(profile.owner);
  const [avatarDialogOpen, setAvatarDialogOpen] = useState(false);
  const profileAvatar = (
    <AgentMascotAvatar
      mascot={profile.mascot}
      name={profile.displayName}
      display={profile.display}
      deleted={Boolean(profile.deletedAt)}
      still
      size="xl"
    />
  );
  const ComputerIcon = profile.computer
    ? computerIcon({
        kind: profile.computer.kind,
        name: profile.computer.label,
        displayName: profile.computer.label,
      })
    : undefined;
  return (
    // `relative` keeps absolutely positioned `sr-only` labels inside this scroll box; without
    // it they escape it and stretch the page.
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <section className="border-b border-secondary px-6 py-5">
        <div className="mb-5 flex flex-wrap items-center gap-4">
          {onMascotChange ? (
            <Button
              color="link-gray"
              noTextPadding
              aria-label={m.agent_avatar_change()}
              className="shrink-0 rounded-full!"
              onPress={() => setAvatarDialogOpen(true)}
            >
              {profileAvatar}
              <span className="absolute -right-1 -bottom-1 grid size-6 place-items-center rounded-full bg-primary text-fg-secondary shadow-xs ring-1 ring-secondary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <Camera01 className="size-3.5" />
              </span>
            </Button>
          ) : (
            profileAvatar
          )}
          {profile.deletedAt && <DeletedAgentBadge />}
          {onMascotChange && (
            <AgentAvatarDialog
              name={profile.displayName}
              mascot={profile.mascot}
              open={avatarDialogOpen}
              onOpenChange={setAvatarDialogOpen}
              onSave={onMascotChange}
            />
          )}
        </div>
        {/* No error snapshot here: the Agent's current error is the banner under the panel header
            (`agent-error-banner.tsx`), on every tab, and the Activity tab is where the record
            lives. */}
        <InlineEditField
          label={m.agent_profile_display_name()}
          value={profile.displayName}
          editable={canManage && !profile.isWeeklyReportAssistant}
          editLabel={m.agent_profile_edit_display_name()}
          saving={false}
          onSave={onSaveDisplayName}
        />
        <InlineEditField
          label={m.agent_profile_description()}
          value={profile.description ?? ""}
          multiline
          editable={canManage}
          editLabel={m.agent_profile_edit_description()}
          saving={false}
          onSave={onSaveDescription}
        />
      </section>

      <section className="border-b border-secondary px-6 py-5">
        <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_info()}</p>
        <div className="mt-3 flex flex-col gap-3">
          <RoleField
            role={profile.role}
            onSave={profile.canManageAgentRole ? onSaveRole : undefined}
          />
          <VisibilityField
            visibility={profile.visibility}
            onRequest={profile.canChangeVisibility ? onRequestVisibilityChange : undefined}
          />
          <FactRow label={m.agent_profile_computer()} className="items-start">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5">
                  {ComputerIcon && (
                    <ComputerIcon className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
                  )}
                  <span className="truncate font-mono">
                    {profile.computer?.label || m.agent_profile_computer_unassigned()}
                  </span>
                </p>
                {profile.computer && (
                  <p className="mt-1 flex items-center gap-1.5 text-xs font-normal text-tertiary">
                    <StatusDot
                      tone={profile.computer.online ? "online" : "offline"}
                      className="size-1.5"
                    />
                    {profile.computer.online
                      ? m.agent_profile_computer_connected()
                      : m.agent_profile_computer_offline()}
                    {profile.computer.computerVersion && (
                      <span className="font-mono">· {profile.computer.computerVersion}</span>
                    )}
                  </p>
                )}
              </div>
              {profile.computer && (
                <AgentDesktopButton
                  computerId={profile.computer.id}
                  agentId={profile.id}
                  title={profile.displayName}
                  kind={profile.computer.kind}
                  online={profile.computer.online === true}
                  owned={profile.computer.ownedByViewer === true}
                />
              )}
            </div>
          </FactRow>
          <FactRow label={m.agent_profile_created()}>
            <RelativeTime value={profile.createdAt} timeZone={timeZone} />
          </FactRow>
          <FactRow label={m.agent_profile_creator()}>
            <span className="flex items-center gap-1.5">
              <IdentityAvatar size="xs" name={creatorName} src={profile.owner.avatarUrl} />
              <span className="truncate">{creatorName}</span>
            </span>
          </FactRow>
        </div>
      </section>

      <section className="border-b border-secondary px-6 py-5">
        <div className="flex items-center gap-1.5">
          <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_runtime()}</p>
          {canEditRuntime && (
            <ButtonUtility
              aria-label={m.agent_profile_edit_runtime_config()}
              tooltip={m.agent_profile_edit_runtime_config()}
              icon={Edit01}
              size="xs"
              color="tertiary"
              onClick={onStartRuntimeEdit}
            />
          )}
          {canManage && runtimeCredentialDialog}
        </div>
        <div className="mt-3 flex flex-col gap-3">
          <FactRow label={m.agent_runtime_field()}>
            {/* The pill names the runtime only; its card holds the usage (owner only) and the
              Agent's context. A runtime with neither has no peek: RuntimeUsage would hand back
              the bare trigger content, not a button. */}
            <FactBadge>
              {usageComputer ? (
                <RuntimeUsage
                  computerId={usageComputer.id}
                  runtime={{
                    provider: runtime,
                    displayName: runtimeLabel,
                    version: profile.runtimeVersion,
                  }}
                  computerOnline={usageComputer.online}
                  timeZone={timeZone}
                  showUsage={profile.runtimeUsageVisible}
                  trigger={(health) => (
                    <>
                      {runtimeIcon}
                      {runtimeLabel}
                      {/* Trailing, like the Computer page's runtime chips. */}
                      <UsageHealthDot health={health} />
                    </>
                  )}
                  triggerClassName={RUNTIME_PILL_TRIGGER_CLASS}
                  footerLabel={context ? m.agent_context_title() : undefined}
                  footer={
                    context ? (
                      <AgentContextSection
                        usage={context}
                        report={
                          supportsContextReport
                            ? {
                                data: contextReport.data,
                                scanning: contextReport.scanning,
                                scanFailed: contextReport.scanFailed,
                                onRefresh: contextReport.refresh,
                              }
                            : undefined
                        }
                        computerOnline={usageComputer.online}
                        timeZone={timeZone}
                      />
                    ) : undefined
                  }
                />
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  {runtimeIcon}
                  {runtimeLabel}
                </span>
              )}
            </FactBadge>
          </FactRow>
          <FactRow label={m.agent_form_model()}>
            <span className={model ? "font-mono break-all" : ""}>
              {model || m.agent_form_provider_default()}
            </span>
          </FactRow>
          <FactRow label={m.agent_form_reasoning()}>
            {reasoning || m.agent_form_provider_default()}
          </FactRow>
          <AgentFastModeFact
            runtime={runtime}
            requested={profile.runtimeConfig.fastMode === true}
            reading={fastMode}
          />
        </div>
      </section>

      {archive}

      {profile.ownedByCurrentUser && onLoadSkills && (
        <div className="border-b border-secondary px-6">
          <AgentSkills
            resetKey={`${profile.id}:${profile.computerId ?? ""}:${JSON.stringify(profile.runtimeConfig)}`}
            onLoad={onLoadSkills}
          />
        </div>
      )}

      {canManage && (
        <section className="px-6 py-5">
          <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_actions()}</p>
          <div className="mt-3 flex flex-col gap-2">
            {/* Moving comes first, as in the reference Computer: it is the action that changes
                where the Agent lives, and its progress belongs at the top while it runs. */}
            {migration}
            <Button
              color="secondary"
              className="w-full justify-center"
              iconLeading={controls.isOnline ? Stop : Play}
              isDisabled={controls.startStopBusy}
              onPress={controls.pressStartOrStop}
            >
              {controls.isOnline ? m.agent_profile_action_stop() : m.agent_profile_action_start()}
            </Button>
            <Button
              color="secondary"
              className="w-full justify-center"
              iconLeading={RotateCcw}
              onPress={() => controls.openRestart("restart")}
            >
              {m.agent_control_restart_reset_tooltip()}
            </Button>
            {onStartDelete && (
              /* A danger entry button is still a button (`docs/design/color-status-typography.md` §11 危险操作), so it
               * gets the bordered red rather than bare red text. The one solid red belongs to the
               * confirm in `AgentDeleteDialog`; `mt-1` keeps a small break between the reversible
               * actions above and this one. */
              <Button
                color="secondary-destructive"
                className="mt-1 w-full justify-center"
                iconLeading={Archive}
                onPress={onStartDelete}
              >
                {m.agent_profile_action_delete()}
              </Button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
