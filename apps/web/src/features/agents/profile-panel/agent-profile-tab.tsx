import { useState, type ReactNode } from "react";
import { DELETED_AGENT_AVATAR_CLASS, DeletedAgentBadge } from "#src/features/agents/deleted-agent";
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
import { Avatar } from "#src/components/base/avatar/avatar";
import { Badge } from "#src/components/base/badges/badges";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { RelativeTime } from "#src/components/ui/relative-time";
import { StatusDot } from "#src/components/ui/status-dot";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { avatarInitial, avatarToneClassName } from "#src/lib/avatar-tone";
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
import { InlineEditField, SECTION_CAPTION_CLASS, SUBFIELD_LABEL_CLASS } from "./inline-edit-field";
import { ContextUsageItem, RUNTIME_PILL_PART_CLASS } from "./agent-context-usage-item";
import { RoleField, VisibilityField } from "./agent-profile-info-fields";

/** Values are never shown in the chip; the dot count hints at length without revealing it. */
function maskEnvValue(value: string) {
  return "•".repeat(Math.min(value.length, 8));
}

type AgentProfile = Awaited<ReturnType<typeof getAgentProfile>>;

/** A small chip-style badge for Runtime / Model / Reasoning and the Role field — the prototype's
 * `.chip`; the app has no separate chip primitive, so this reuses the official `Badge` at
 * `color="gray"`, the same "short fact" vocabulary `docs/design/color-status-typography.md` §11 already uses. */
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
 * The Agent profile panel's Profile tab body: label-over-value throughout, no left/right fact
 * rows, no leading row icons (`docs/design/field-display.md` §9's field-grid style, per the approved
 * prototype). Managers/owners get the pencils, INFO's Role editor, RUNTIME CONFIG's credential
 * dialog and the ACTIONS section; everyone else sees a read-only Profile.
 */
export function AgentProfileTab({
  profile,
  timeZone,
  canManage,
  controls,
  onSaveDisplayName,
  onSaveDescription,
  onAvatarChange,
  onAvatarChoosePicture,
  onAvatarRemove,
  onSaveRole,
  onRequestVisibilityChange,
  runtimeCredentialDialog,
  onStartRuntimeEdit,
  onLoadSkills,
  envVars,
  onStartDelete,
  migration,
  archive,
  contextUsage,
}: {
  profile: NonNullable<AgentProfile>;
  timeZone: string | null;
  /** The Agent's current context-window usage, or `null` when there is no reading —
   * hidden entirely in that case. Display only: coloured by risk, but nothing triggers on it. */
  contextUsage?: { usedTokens: number; windowTokens: number; observedAtMs: number } | null;
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
  onAvatarChange?: (file: File) => Promise<void>;
  onAvatarChoosePicture?: (pictureId: string) => Promise<void>;
  onAvatarRemove?: () => Promise<void>;
  onSaveRole?: (role: "admin" | "member") => Promise<void>;
  /** Opens the container's `AgentVisibilityConfirmDialog` for the given target visibility.
   * Present only for the creator or a human Workspace owner/admin. */
  onRequestVisibilityChange?: (target: AgentVisibility) => void;
  runtimeCredentialDialog: ReactNode;
  /** Opens the container's `AgentRuntimeConfigDialog` (see `agent-profile-panel.tsx`). The
   * RUNTIME CONFIG badges below never change; only the pencil does anything. */
  onStartRuntimeEdit?: () => void;
  /** Owner-only, same as the old Agent detail page's Skills section. Omitted for a viewer who
   * does not own the Agent. */
  onLoadSkills?: () => Promise<AgentSkillsLoadResult>;
  /** Opens the container's `AgentDeleteDialog`. Present only when the viewer holds
   * the `deleteAgents` capability and this Agent is a delete target at all. */
  onStartDelete?: () => void;
  /** Owner-only read view of the Agent's launch environment overrides, masked; editing happens in
   * the Runtime config dialog's Advanced disclosure (`agent-runtime-config-dialog.tsx`).
   * `undefined` for a viewer who does not own the Agent (the GET is owner-only); an owner whose
   * query has not resolved yet gets `{}`, same empty-state copy as a genuinely empty map. */
  envVars?: Record<string, string>;
}) {
  const { runtime, model, reasoning } = profile.runtimeConfig;
  const canEditRuntime = canManage && Boolean(onStartRuntimeEdit);
  const needsComputerSetup = canManage && !profile.computer;
  const runtimeLabel = runtimeProviderLabel(runtime);
  const runtimeIcon = <RuntimeProviderMark provider={runtime} className="size-3.5" />;
  const creatorName = humanLabel(profile.owner);
  const [avatarDialogOpen, setAvatarDialogOpen] = useState(false);
  const profileAvatar = (
    <Avatar
      size="xl"
      src={profile.avatarUrl}
      alt={profile.displayName}
      initials={avatarInitial(profile.displayName)}
      contentClassName={
        profile.deletedAt ? DELETED_AGENT_AVATAR_CLASS : avatarToneClassName(profile.displayName)
      }
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
          {onAvatarChange ? (
            <Button
              color="link-gray"
              noTextPadding
              aria-label={m.agent_avatar_change()}
              className="shrink-0 rounded-full!"
              onPress={() => setAvatarDialogOpen(true)}
            >
              {profileAvatar}
              <span className="absolute inset-0 grid place-items-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                <Camera01 className="size-5" />
              </span>
            </Button>
          ) : (
            profileAvatar
          )}
          {profile.deletedAt && <DeletedAgentBadge />}
          {onAvatarChange && onAvatarChoosePicture && (
            <AgentAvatarDialog
              name={profile.displayName}
              avatarUrl={profile.avatarUrl ?? null}
              open={avatarDialogOpen}
              onOpenChange={setAvatarDialogOpen}
              onUpload={onAvatarChange}
              onChoosePicture={onAvatarChoosePicture}
              onRemove={profile.avatarUrl ? onAvatarRemove : undefined}
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
        <div className="mt-3 grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
          <RoleField
            role={profile.role}
            onSave={profile.canManageAgentRole ? onSaveRole : undefined}
          />
          <VisibilityField
            visibility={profile.visibility}
            onRequest={profile.canChangeVisibility ? onRequestVisibilityChange : undefined}
          />
        </div>
        <div className="mt-4">
          <p className={SUBFIELD_LABEL_CLASS}>{m.agent_profile_computer()}</p>
          <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-primary">
            {ComputerIcon && (
              <ComputerIcon className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
            )}
            <span className="truncate font-mono">
              {profile.computer?.label || m.agent_profile_computer_unassigned()}
            </span>
          </p>
          {profile.computer && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-tertiary">
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
          {profile.computer ? (
            <AgentDesktopButton
              computerId={profile.computer.id}
              agentId={profile.id}
              kind={profile.computer.kind}
              online={profile.computer.online === true}
              owned={profile.computer.ownedByViewer === true}
            />
          ) : null}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-4">
          <div>
            <p className={SUBFIELD_LABEL_CLASS}>{m.agent_profile_created()}</p>
            <p className="mt-1 text-sm font-medium text-primary">
              <RelativeTime value={profile.createdAt} timeZone={timeZone} />
            </p>
          </div>
          <div>
            <p className={SUBFIELD_LABEL_CLASS}>{m.agent_profile_creator()}</p>
            <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-primary">
              <Avatar
                size="xs"
                alt=""
                src={profile.owner.avatarUrl ?? undefined}
                initials={avatarInitial(creatorName)}
                contentClassName={avatarToneClassName(creatorName)}
              />
              <span className="truncate">{creatorName}</span>
            </p>
          </div>
        </div>
      </section>

      <section className="border-b border-secondary px-6 py-5">
        <div className="flex items-center gap-1.5">
          <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_runtime()}</p>
          {canEditRuntime && !needsComputerSetup && (
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
        {needsComputerSetup && onStartRuntimeEdit && (
          <div className="mt-3">
            <Button color="secondary" size="sm" onPress={onStartRuntimeEdit}>
              {m.agent_profile_setup_runtime()}
            </Button>
          </div>
        )}
        <div className={`flex flex-wrap gap-x-8 gap-y-4 ${needsComputerSetup ? "mt-4" : "mt-3"}`}>
          <div>
            <p className={SUBFIELD_LABEL_CLASS}>{m.agent_runtime_field()}</p>
            {/* One pill: the runtime (its usage peek) and, once reported, its context (the
                context peek). Each part stays its own button inside it. */}
            <p className="mt-1">
              <FactBadge>
                {/* A runtime without a usage reader has no peek: RuntimeUsage would hand back the
                  bare trigger content, not a button. */}
                {profile.runtimeUsageVisible &&
                profile.computer &&
                RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN[runtime] ? (
                  <RuntimeUsage
                    computerId={profile.computer.id}
                    runtime={{
                      provider: runtime,
                      displayName: runtimeLabel,
                      version: profile.runtimeVersion,
                    }}
                    computerOnline={profile.computer.online}
                    timeZone={timeZone}
                    trigger={(health) => (
                      <>
                        {runtimeIcon}
                        {runtimeLabel}
                        {/* Trailing, like the Computer page's runtime chips. */}
                        <UsageHealthDot health={health} />
                      </>
                    )}
                    triggerClassName={RUNTIME_PILL_PART_CLASS}
                  />
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    {runtimeIcon}
                    {runtimeLabel}
                  </span>
                )}
                {contextUsage && !profile.deletedAt && (
                  <>
                    {/* A hairline, not a "·": beside the health dot a dot separator reads as a
                        second status dot. */}
                    <span
                      aria-hidden="true"
                      className="mx-0.5 h-3 w-px shrink-0 bg-border-secondary"
                    />
                    <ContextUsageItem
                      agentId={profile.id}
                      contextUsage={contextUsage}
                      timeZone={timeZone}
                      supportsContextReport={runtime === RUNTIME_PROVIDER.CLAUDE_CODE}
                      computerOnline={profile.computer?.online}
                    />
                  </>
                )}
              </FactBadge>
            </p>
          </div>
          <div>
            <p className={SUBFIELD_LABEL_CLASS}>{m.agent_form_model()}</p>
            <p className="mt-1">
              <FactBadge mono={Boolean(model)}>
                {model || m.agent_form_provider_default()}
              </FactBadge>
            </p>
          </div>
          <div>
            <p className={SUBFIELD_LABEL_CLASS}>{m.agent_form_reasoning()}</p>
            <p className="mt-1">
              <FactBadge>{reasoning || m.agent_form_provider_default()}</FactBadge>
            </p>
          </div>
        </div>
        {envVars && (
          <div className="mt-4">
            <p className={SUBFIELD_LABEL_CLASS}>{m.agent_env_title()}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {Object.keys(envVars).length > 0 ? (
                Object.entries(envVars).map(([key, value]) => (
                  <Tooltip key={key} title={`${key}=${value}`}>
                    <TooltipTrigger>
                      <Badge color="gray" size="sm" className="font-mono">
                        {key}={maskEnvValue(value)}
                      </Badge>
                    </TooltipTrigger>
                  </Tooltip>
                ))
              ) : (
                <p className="text-sm text-tertiary italic">{m.agent_env_none()}</p>
              )}
            </div>
          </div>
        )}
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
