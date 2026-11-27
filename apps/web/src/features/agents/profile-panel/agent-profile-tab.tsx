import { useState, type ComponentProps, type ReactNode } from "react";
import { Camera01, Edit01 } from "@untitledui/icons";
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
import { AgentDesktopThumbnail } from "#src/features/computers/agent-desktop-thumbnail";
import { ComputerGlyph } from "#src/features/computers/computer-status-icon";
import { canOfferAgentResetCredit } from "#src/features/computers/runtime-reset-credit-state";
import { RuntimeUsage, UsageHealthDot } from "#src/features/computers/runtime-usage";
import { type AgentRuntimeControls } from "#src/features/agents/agent-runtime-controls";
import type { getAgentProfile } from "#src/features/agents/agents.functions";
import { AgentSkills, type AgentSkillsLoadResult } from "#src/features/agents/agent-skills";
import type { AgentVisibility } from "#src/features/agents/agent-visibility";
import { AgentContextSection } from "#src/features/agents/agent-context-section";
import { InlineEditField, SECTION_CAPTION_CLASS } from "./inline-edit-field";
import { AgentCodexCompatibleFact } from "./agent-codex-compatible-fact";
import { AgentFastModeFact, type AgentFastModeReading } from "./agent-fast-mode-fact";
import { FactRow } from "./agent-fact-row";
import { AppBotProfile } from "./app-bot-profile";
import { AgentProfileActionsSection } from "./agent-profile-actions-section";
import { ExternalAgentAccessSection } from "./external-agent-access-section";
import { ExternalConnectionState } from "#src/features/agents/external-agent-setup";
import { RoleField, VisibilityField } from "./agent-profile-info-fields";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { useAgentModelName } from "#src/features/agents/use-agent-model-name";

type AgentProfile = Awaited<ReturnType<typeof getAgentProfile>>;

const RUNTIME_PILL_TRIGGER_CLASS =
  "inline-flex items-center gap-1.5 rounded-sm outline-none data-focus-visible:ring-2 data-focus-visible:ring-brand";

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

export function AgentProfileTab(props: ComponentProps<typeof AgentProfileTabBody>) {
  const { profile, timeZone } = props;
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
  onRefreshExternal,
  migration,
  computerAccessRevoked = false,
  archive,
  contextUsage,
  fastMode,
}: {
  profile: NonNullable<AgentProfile>;
  timeZone: string | null;
  contextUsage?: {
    usedTokens: number;
    windowTokens: number;
    observedAtMs: number;
  } | null;
  fastMode?: AgentFastModeReading | null;
  migration?: ReactNode;
  computerAccessRevoked?: boolean;
  archive?: ReactNode;
  canManage: boolean;
  controls: AgentRuntimeControls;
  onSaveDisplayName: (value: string) => Promise<void>;
  onSaveDescription: (value: string) => Promise<void>;
  onMascotChange?: (mascot: AgentMascot) => Promise<void>;
  onSaveRole?: (role: "admin" | "member") => Promise<void>;
  onRequestVisibilityChange?: (target: AgentVisibility) => void;
  runtimeCredentialDialog: ReactNode;
  onStartRuntimeEdit?: () => void;
  onLoadSkills?: () => Promise<AgentSkillsLoadResult>;
  onStartDelete?: () => void;
  onRefreshExternal?: () => Promise<void> | void;
}) {
  const isExternal = profile.hosting === "external";
  const runtimeConfig = profile.runtimeConfig;
  const modelLabel = useAgentModelName(profile.id, runtimeConfig?.model ?? "");
  const canEditRuntime =
    canManage &&
    !isExternal &&
    Boolean(onStartRuntimeEdit) &&
    (Boolean(runtimeConfig) || profile.runtimeConfigInvalid === true);
  const runtimeLabel = runtimeConfig ? runtimeProviderLabel(runtimeConfig.runtime) : "";
  const runtimeIcon = runtimeConfig ? (
    <RuntimeProviderMark provider={runtimeConfig.runtime} className="size-3.5" />
  ) : null;
  const context = profile.deletedAt ? null : contextUsage;
  const usageComputer =
    profile.computer &&
    runtimeConfig &&
    (context ||
      (profile.runtimeUsageVisible && RUNTIME_PROVIDER_SUPPORTS_USAGE_SCAN[runtimeConfig.runtime]))
      ? profile.computer
      : undefined;
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
  return (
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
              <span className="absolute -right-1 -bottom-1 grid size-6 place-items-center rounded-full bg-primary text-fg-secondary shadow-xs ring-1 ring-secondary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100">
                <Camera01 className="size-3.5" />
              </span>
            </Button>
          ) : (
            profileAvatar
          )}
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
          {isExternal ? (
            <FactRow label={m.agent_create_kind_label()}>
              <FactBadge>{m.external_agent_badge()}</FactBadge>
            </FactRow>
          ) : (
            <FactRow label={m.agent_profile_computer()} className="items-start">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5">
                    {profile.computer && (
                      <ComputerGlyph
                        kind={profile.computer.kind}
                        className="size-4 shrink-0 text-tertiary"
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate">
                      {profile.computer?.label || m.agent_profile_computer_unassigned()}
                    </span>
                  </p>
                  {profile.computer && !computerAccessRevoked && (
                    <p className="mt-1 flex items-center gap-1.5 text-xs font-normal text-tertiary">
                      <StatusDot
                        tone={profile.computer.online ? "online" : "offline"}
                        className="size-1.5"
                      />
                      {profile.computer.online
                        ? m.agent_profile_computer_connected()
                        : m.agent_profile_computer_offline()}
                      {profile.computer.computerVersion && (
                        <span dir="ltr" className="text-quaternary">
                          {profile.computer.computerVersion}
                        </span>
                      )}
                    </p>
                  )}
                </div>
                {profile.computer && (
                  <AgentDesktopThumbnail
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
          )}
          <FactRow label={m.agent_profile_created()}>
            <RelativeTime value={profile.createdAt} timeZone={timeZone} />
          </FactRow>
          <FactRow label={m.agent_profile_creator()}>
            <span className="flex items-center gap-1.5">
              <ActorAvatar
                presence={false}
                size="xs"
                name={creatorName}
                src={profile.owner.avatarUrl}
              />
              <span className="truncate">{creatorName}</span>
            </span>
          </FactRow>
        </div>
      </section>

      {isExternal ? (
        canManage && profile.externalSetup ? (
          <ExternalAgentAccessSection
            agentId={profile.id}
            agentName={profile.name}
            displayName={profile.displayName}
            workspaceSlug={profile.workspaceSlug}
            setup={profile.externalSetup}
            connectTarget={profile.externalConnectTarget}
            credentials={profile.externalCredentials}
            timeZone={timeZone}
            onChanged={onRefreshExternal}
          />
        ) : profile.externalSetup ? (
          <section className="border-b border-secondary px-6 py-5">
            <p className={SECTION_CAPTION_CLASS}>{m.external_agent_setup_section()}</p>
            <div className="mt-3">
              <ExternalConnectionState
                setup={profile.externalSetup}
                displayName={profile.displayName}
                timeZone={timeZone}
                askOwner={creatorName}
              />
            </div>
          </section>
        ) : null
      ) : (
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
          {profile.runtimeConfigInvalid === true && (
            <p className="mt-3 text-sm text-destructive-primary">
              {m.agent_profile_runtime_invalid()}
            </p>
          )}
          <div className="mt-3 flex flex-col gap-3">
            {runtimeConfig && (
              <>
                <FactRow label={m.agent_runtime_field()}>
                  <FactBadge>
                    {usageComputer ? (
                      <RuntimeUsage
                        computerId={usageComputer.id}
                        runtime={{
                          provider: runtimeConfig!.runtime,
                          displayName: runtimeLabel,
                          version: profile.runtimeVersion,
                        }}
                        computerOnline={usageComputer.online}
                        timeZone={timeZone}
                        showUsage={profile.runtimeUsageVisible}
                        canResetCredit={canOfferAgentResetCredit(profile)}
                        agentUsage={
                          runtimeConfig.runtime === RUNTIME_PROVIDER.CODEX
                            ? {
                                agentId: profile.id,
                                runtimeConfigRevision: profile.runtimeUsageRevision ?? 0,
                              }
                            : undefined
                        }
                        trigger={(health) => (
                          <>
                            {runtimeIcon}
                            {runtimeLabel}
                            <UsageHealthDot health={health} />
                          </>
                        )}
                        triggerClassName={RUNTIME_PILL_TRIGGER_CLASS}
                        footerLabel={context ? m.agent_context_title() : undefined}
                        footer={
                          context ? (
                            <AgentContextSection usage={context} timeZone={timeZone} />
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
                <AgentCodexCompatibleFact provider={runtimeConfig!.provider} />
                <FactRow label={m.agent_form_model()}>
                  <span className={runtimeConfig!.model ? "break-words" : ""}>
                    {runtimeConfig!.model ? modelLabel : m.agent_form_provider_default()}
                  </span>
                </FactRow>
                <FactRow label={m.agent_form_reasoning()}>
                  {runtimeConfig!.reasoning || m.agent_form_provider_default()}
                </FactRow>
                <AgentFastModeFact
                  runtime={runtimeConfig!.runtime}
                  requested={profile.runtimeConfig!.fastMode === true}
                  reading={fastMode}
                />
              </>
            )}
          </div>
        </section>
      )}

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
        <AgentProfileActionsSection
          isExternal={isExternal}
          controls={controls}
          migration={migration}
          onStartDelete={onStartDelete}
        />
      )}
    </div>
  );
}
