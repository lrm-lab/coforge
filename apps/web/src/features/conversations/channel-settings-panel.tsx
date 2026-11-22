import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useBlocker, type ShouldBlockFn } from "@tanstack/react-router";
import { User01 } from "@untitledui/icons";

import { Select } from "#src/components/base/select/select";
import { Toggle } from "#src/components/base/toggle/toggle";
import { UnsavedChangesDialog } from "#src/components/ui/unsaved-changes-dialog";
import { AgentProfilePanel } from "#src/features/agents/profile-panel/agent-profile-panel";
import { PersonProfilePanel } from "#src/features/agents/person-profile-panel";
import type { AgentProfileTab as AgentProfileTabId } from "#src/features/agents/profile-panel/profile-panel-search";
import { OPEN_OVERLAY_SELECTOR } from "#src/lib/open-overlay";
import { m } from "#src/paraglide/messages";
import { useServerFn } from "@tanstack/react-start";
import { ChannelActionConfirmDialog, type ConfirmedAction } from "./channel-action-confirm-dialog";
import type { ChannelConversationView } from "./channel-conversation";
import { useDirectChannelAction, type DirectChannelAction } from "./channel-direct-actions";
import {
  ChannelMembersPage,
  type ChannelMembersView,
  type RosterProfile,
} from "./channel-members-page";
import { MembersStrip } from "./channel-members-strip";
import { ActionsSection } from "./channel-settings-actions";
import { ChannelSettingsGroup } from "./channel-settings-group";
import { MembersPageHeading } from "./channel-settings-header";
import { ChannelIdentitySection, useInfoForm } from "./channel-settings-info";
import { isPrivateChannel } from "./channel-visibility";
import { setPublicChannelCollapseLongMessages } from "./channels.functions";
import {
  CHANNEL_NOTIFICATION_LEVELS,
  notificationLevelDescription,
  notificationLevelLabel,
  notificationLevelOf,
  type ChannelNotificationLevel,
} from "./notification-levels";
import {
  DetailsPaneHeader,
  PreferenceRow,
  SectionEyebrow,
  SettingsCard,
} from "./settings-panel-parts";
import { useSidebarActions, useSidebarLists } from "./sidebar-lists";
import { SidebarSectionSelect } from "./sidebar-section-select";
import { StopChannelAgentsDialog } from "./stop-channel-agents-dialog";

export function ChannelSettingsPanel({
  conversation,
  open,
  membersView,
  onMembersViewChange,
  onClose,
  onChanged,
}: {
  conversation: ChannelConversationView;
  open: boolean;
  membersView: ChannelMembersView | null;
  onMembersViewChange: (view: ChannelMembersView | null) => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const channelId = conversation.conversationId;
  const capabilities = conversation.channelCapabilities;
  const isMember = Boolean(conversation.senderMemberId);
  const activeMembersView =
    conversation.archived && membersView === "add" ? "members" : membersView;
  const [profile, setProfile] = useState<RosterProfile | null>(null);
  const [profileTab, setProfileTab] = useState<AgentProfileTabId | undefined>(undefined);
  const [rosterSearch, setRosterSearch] = useState("");
  const [returnFocus, setReturnFocus] = useState<RosterProfile | undefined>(undefined);
  const [editingInfo, setEditingInfo] = useState(false);
  const [confirming, setConfirming] = useState<ConfirmedAction | null>(null);
  const [stoppingAgents, setStoppingAgents] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const info = useInfoForm(conversation, onChanged);
  const dirtyRef = useRef(info.dirty);
  dirtyRef.current = info.dirty;

  const finishAction = async () => {
    dirtyRef.current = false;
    info.reset();
    setEditingInfo(false);
    setConfirming(null);
    onClose();
    await onChanged();
  };

  const runDirect = useDirectChannelAction({
    channelId,
    channelName: conversation.name,
    onDone: finishAction,
  });

  const onAction = (kind: ConfirmedAction | DirectChannelAction) => {
    if (kind === "delete" || kind === "make-public") return setConfirming(kind);
    if (kind === "leave" && isPrivateChannel(conversation)) return setConfirming(kind);
    void runDirect(kind);
  };

  useHotkey(
    "Escape",
    (event) => {
      if (sectionRef.current?.offsetParent === null) return;
      if (document.querySelector(OPEN_OVERLAY_SELECTOR) !== null) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && active.type === "search" && active.value !== "")
        return;
      event.preventDefault();
      event.stopPropagation();
      if (editingInfo && !info.dirty) {
        setEditingInfo(false);
        return;
      }
      onClose();
    },
    { enabled: open, capture: true, preventDefault: false, stopPropagation: false },
  );

  const shouldBlock = useCallback<ShouldBlockFn>(({ current, next }) => {
    if (!dirtyRef.current) return false;
    const nextDetails = (next.search as { details?: unknown }).details;
    return next.pathname !== current.pathname || nextDetails !== "panel";
  }, []);
  const shouldBeforeUnload = useCallback(() => dirtyRef.current, []);
  const blocker = useBlocker({
    shouldBlockFn: shouldBlock,
    enableBeforeUnload: shouldBeforeUnload,
    disabled: !open,
    withResolver: true,
  });

  useEffect(() => {
    if (!open) {
      setEditingInfo(false);
      setProfile(null);
      setRosterSearch("");
      setReturnFocus(undefined);
    }
  }, [open, channelId]);

  useEffect(() => {
    setProfile(null);
    setReturnFocus(undefined);
    setRosterSearch("");
  }, [activeMembersView]);

  useEffect(() => {
    if (conversation.archived) setEditingInfo(false);
  }, [conversation.archived]);

  const openProfile = useCallback((next: RosterProfile, tab?: AgentProfileTabId) => {
    setProfileTab(tab);
    setProfile(next);
  }, []);

  const profileBack = useMemo(
    () => ({
      label: m.channel_members_back_to_members(),
      onPress: () => {
        setReturnFocus(profile ?? undefined);
        setProfile(null);
      },
    }),
    [profile],
  );

  const changeMembersView = useCallback(
    (view: ChannelMembersView | null) => {
      setReturnFocus(undefined);
      setRosterSearch("");
      onMembersViewChange(view);
    },
    [onMembersViewChange],
  );

  return (
    <>
      {open && (
        <section
          ref={sectionRef}
          aria-label={m.channel_settings_open()}
          className="flex min-h-0 min-w-0 flex-1 flex-col bg-primary"
        >
          {profile ? (
            <div className="flex min-h-0 w-full flex-1 flex-col">
              {profile.kind === "agent" ? (
                <AgentProfilePanel
                  key={profile.id}
                  agentId={profile.id}
                  visible={open}
                  requestedTab={profileTab}
                  onTabChange={setProfileTab}
                  onClose={onClose}
                  back={profileBack}
                />
              ) : (
                <PersonProfilePanel
                  key={profile.id}
                  userId={profile.id}
                  onClose={onClose}
                  back={profileBack}
                  onOpenAgent={(agentId) => openProfile({ kind: "agent", id: agentId })}
                />
              )}
            </div>
          ) : (
            <>
              <DetailsPaneHeader title={m.conversation_details_title()} onClose={onClose} />
              {activeMembersView ? (
                <>
                  <MembersPageHeading
                    key={activeMembersView}
                    channelId={channelId}
                    view={activeMembersView}
                    takesFocus={!returnFocus}
                    onBack={() => changeMembersView(activeMembersView === "add" ? "members" : null)}
                  />
                  <div className="flex min-h-0 w-full flex-1 flex-col">
                    <ChannelMembersPage
                      channelId={channelId}
                      channelName={conversation.name}
                      viewerId={conversation.viewerId}
                      canCreateAgents={conversation.canCreateAgents}
                      view={activeMembersView}
                      onViewChange={changeMembersView}
                      roster={{
                        search: rosterSearch,
                        onSearchChange: setRosterSearch,
                        onOpenProfile: openProfile,
                        returnFocus,
                      }}
                    />
                  </div>
                </>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4 pb-6 md:px-6">
                  <ChannelIdentitySection
                    conversation={conversation}
                    form={info}
                    canEdit={capabilities.update}
                    editing={editingInfo}
                    onStartEdit={() => setEditingInfo(true)}
                    onCancelEdit={() => setEditingInfo(false)}
                    onSaved={() => setEditingInfo(false)}
                  />
                  <MembersStrip
                    channelId={channelId}
                    canAdd={isMember && !conversation.archived}
                    onOpenMembers={() => changeMembersView("members")}
                    onAddMembers={() => changeMembersView("add")}
                  />
                  <ChannelSettingsGroup
                    conversation={conversation}
                    onAction={onAction}
                    onChanged={onChanged}
                  />
                  {isMember && (
                    <PreferencesSection conversation={conversation} onChanged={onChanged} />
                  )}
                  <ActionsSection
                    conversation={conversation}
                    onConfirm={onAction}
                    onStopAgents={() => setStoppingAgents(true)}
                    onChanged={onChanged}
                  />
                </div>
              )}
            </>
          )}
        </section>
      )}
      <UnsavedChangesDialog
        open={blocker.status === "blocked"}
        saving={info.saving}
        description={m.channel_settings_unsaved_message()}
        onKeepEditing={() => blocker.reset?.()}
        onDiscard={() => {
          dirtyRef.current = false;
          info.reset();
          setEditingInfo(false);
          blocker.proceed?.();
        }}
        onSave={async () => {
          const saved = await info.save();
          if (saved) {
            dirtyRef.current = false;
            setEditingInfo(false);
            blocker.proceed?.();
          } else {
            blocker.reset?.();
          }
        }}
      />
      {stoppingAgents && (
        <StopChannelAgentsDialog
          channelId={channelId}
          channelName={conversation.name}
          onClose={() => setStoppingAgents(false)}
        />
      )}
      <ChannelActionConfirmDialog
        kind={confirming}
        channelId={channelId}
        channelName={conversation.name}
        onClose={() => setConfirming(null)}
        onDone={finishAction}
      />
    </>
  );
}

function PreferencesSection({
  conversation,
  onChanged,
}: {
  conversation: ChannelConversationView;
  onChanged: () => Promise<void>;
}) {
  const actions = useSidebarActions();
  const setCollapse = useServerFn(setPublicChannelCollapseLongMessages);
  const [pending, setPending] = useState<"mute" | "collapse" | null>(null);
  const [error, setError] = useState("");
  const channelId = conversation.conversationId;
  const listed = useSidebarLists().channels.find((channel) => channel.id === channelId);
  const level = notificationLevelOf(listed ?? conversation);

  async function change(which: "mute" | "collapse", write: () => Promise<unknown>) {
    setPending(which);
    setError("");
    try {
      await write();
      await onChanged();
    } catch {
      setError(m.channel_settings_preference_error());
    } finally {
      setPending(null);
    }
  }

  return (
    <section>
      <SectionEyebrow icon={User01} title={m.channel_settings_preferences()} />
      <SettingsCard divided>
        <PreferenceRow title={m.channel_notify()} description={notificationLevelDescription(level)}>
          <Select
            aria-label={m.channel_notify()}
            size="sm"
            className="w-44"
            selectedKey={level}
            isDisabled={pending !== null}
            onSelectionChange={(key) => {
              const next = key as ChannelNotificationLevel | null;
              if (next === null || next === level) return;
              void change("mute", () => actions.setNotificationLevel(channelId, next));
            }}
          >
            {CHANNEL_NOTIFICATION_LEVELS.map((each) => (
              <Select.Item key={each} id={each} label={notificationLevelLabel(each)} />
            ))}
          </Select>
        </PreferenceRow>
        <PreferenceRow title={m.conversation_sidebar_section()}>
          <SidebarSectionSelect
            target={{ kind: "channel", channelId }}
            fallbackPinned={conversation.pinned}
            isDisabled={pending !== null || conversation.archived}
            onChanged={onChanged}
            onError={() => setError(m.channel_settings_preference_error())}
          />
        </PreferenceRow>
        <PreferenceRow title={m.channel_settings_collapse_long_messages()}>
          <Toggle
            size="md"
            aria-label={m.channel_settings_collapse_long_messages()}
            isSelected={conversation.collapseLongMessages === true}
            isDisabled={pending !== null}
            onChange={(collapseLongMessages) =>
              void change("collapse", () =>
                setCollapse({ data: { channelId, collapseLongMessages } }),
              )
            }
          />
        </PreferenceRow>
      </SettingsCard>
      {error && (
        <p role="alert" className="mt-2 text-sm text-error-primary">
          {error}
        </p>
      )}
    </section>
  );
}
