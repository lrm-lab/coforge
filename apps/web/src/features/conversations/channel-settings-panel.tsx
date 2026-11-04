import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OVERLAY_LAYER } from "#src/lib/overlay-layer";
import { useServerFn } from "@tanstack/react-start";

import {
  Dialog as SlideoutDialog,
  Modal as SlideoutModal,
  ModalOverlay as SlideoutOverlay,
  SlideoutMenu,
} from "#src/components/application/slideout-menus/slideout-menu";
import { Select } from "#src/components/base/select/select";
import { Toggle } from "#src/components/base/toggle/toggle";
import { EntityPickerField, memberOption } from "#src/features/pickers/entity-picker";
import { useAppToast } from "#src/components/ui/toast";
import { AgentProfilePanel } from "#src/features/agents/profile-panel/agent-profile-panel";
import { PersonProfilePanel } from "#src/features/agents/person-profile-panel";
import type { AgentProfileTab as AgentProfileTabId } from "#src/features/agents/profile-panel/profile-panel-search";
import { UnsavedChangesDialog } from "#src/components/ui/unsaved-changes-dialog";
import { m } from "#src/paraglide/messages";
import type { ChannelConversationView } from "./channel-conversation";
import {
  ChannelMembersPage,
  type ChannelMembersView,
  type RosterProfile,
} from "./channel-members-page";
import { MembersStrip } from "./channel-members-strip";
import {
  ChannelSettingsTitle,
  MembersPageHeading,
  SettingsPanelHeader,
} from "./channel-settings-header";
import {
  CHANNEL_NOTIFICATION_LEVELS,
  notificationLevelDescription,
  notificationLevelLabel,
  notificationLevelOf,
  type ChannelNotificationLevel,
} from "./notification-levels";
import { PanelSection, PreferenceRow } from "./settings-panel-parts";
import { useSidebarActions, useSidebarLists } from "./sidebar-lists";
import {
  setPublicChannelCoordinator,
  setPublicChannelCollapseLongMessages,
  setPublicConversationPinned,
} from "./channels.functions";
import { ChannelActionConfirmDialog, type ConfirmedAction } from "./channel-action-confirm-dialog";
import { ActionsSection } from "./channel-settings-actions";
import { StopChannelAgentsDialog } from "./stop-channel-agents-dialog";
import { InfoForm, useInfoForm } from "./channel-settings-info";

/**
 * The channel header's details-and-settings slideout: identity, the Members strip, the Info form
 * (name and description, for channel admins), the viewer's own preferences (pin, mute), and the
 * channel actions (archive, leave; hiding #general or deleting the channel for an owner or admin).
 * Closing with unsaved Info edits asks first.
 */
export function ChannelSettingsPanel({
  conversation,
  open,
  initialMembersView = null,
  onOpenChange,
  onChanged,
}: {
  conversation: ChannelConversationView;
  open: boolean;
  /** Members page to land on when the panel opens. Null is the settings themselves. The header's
   * invite button passes `"add"`; the face stack passes `"members"`. */
  initialMembersView?: ChannelMembersView | null;
  onOpenChange: (open: boolean) => void;
  /** Refreshes the page and the sidebar after a write changed the channel or the membership. */
  onChanged: () => Promise<void>;
}) {
  const channelId = conversation.conversationId;
  const capabilities = conversation.channelCapabilities;
  const isMember = Boolean(conversation.senderMemberId);
  // The members page (or its add view) shown in place of the settings; null shows the settings.
  const [membersView, setMembersView] = useState<ChannelMembersView | null>(initialMembersView);
  // A member's profile (an Agent's or a person's) opened from the members page, shown in place of
  // it; Back returns there.
  const [profile, setProfile] = useState<RosterProfile | null>(null);
  const [profileTab, setProfileTab] = useState<AgentProfileTabId | undefined>(undefined);
  const [rosterSearch, setRosterSearch] = useState("");
  const [returnFocus, setReturnFocus] = useState<RosterProfile | undefined>(undefined);
  const [unsavedPromptOpen, setUnsavedPromptOpen] = useState(false);
  const [confirming, setConfirming] = useState<ConfirmedAction | null>(null);
  const [stoppingAgents, setStoppingAgents] = useState(false);
  const info = useInfoForm(conversation, onChanged);
  // What to do once the panel has closed, held while unsaved edits are being confirmed.
  const afterClose = useRef<(() => void) | undefined>(undefined);

  // Each opening lands on the view the opener asked for (the settings, when it asked for none).
  // Read through a ref so a parent that clears the request after close does not reopen the page.
  const initialMembersViewRef = useRef(initialMembersView);
  initialMembersViewRef.current = initialMembersView;
  useEffect(() => {
    if (!open) return;
    setMembersView(initialMembersViewRef.current);
    setProfile(null);
    setRosterSearch("");
    setReturnFocus(undefined);
  }, [open]);

  function close() {
    onOpenChange(false);
    afterClose.current?.();
    afterClose.current = undefined;
  }

  /** Every way out of the panel comes through here, so unsaved Info edits always ask first. */
  function requestClose(then?: () => void) {
    afterClose.current = then;
    if (info.dirty) setUnsavedPromptOpen(true);
    else close();
  }
  // Stable, so the memoized roster rows do not re-render with the panel. `tab` comes from the
  // Agent card's Recent activity link (the roster's peek cards); no tab means the default one.
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
  // The roster's search and the focused row survive only a trip to a profile and back; any
  // other view change starts the roster afresh, as it did before it kept them.
  const changeMembersView = useCallback((view: ChannelMembersView | null) => {
    setReturnFocus(undefined);
    setRosterSearch("");
    setMembersView(view);
  }, []);

  return (
    <>
      <SlideoutOverlay
        className={OVERLAY_LAYER}
        isOpen={open}
        isDismissable
        onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}
      >
        <SlideoutModal className="max-w-136">
          <SlideoutDialog aria-label={m.channel_settings_open()} className="gap-0">
            {profile ? (
              <div className="flex min-h-0 w-full flex-1 flex-col">
                {profile.kind === "agent" ? (
                  <AgentProfilePanel
                    key={profile.id}
                    agentId={profile.id}
                    requestedTab={profileTab}
                    onTabChange={setProfileTab}
                    onClose={() => requestClose()}
                    back={profileBack}
                  />
                ) : (
                  <PersonProfilePanel
                    key={profile.id}
                    userId={profile.id}
                    onClose={() => requestClose()}
                    back={profileBack}
                    // One of their Agents opens here too, and Back still returns to the members.
                    onOpenAgent={(agentId) => openProfile({ kind: "agent", id: agentId })}
                  />
                )}
              </div>
            ) : (
              <>
                <SettingsPanelHeader>
                  {membersView ? (
                    <MembersPageHeading
                      key={membersView}
                      channelId={channelId}
                      view={membersView}
                      takesFocus={!returnFocus}
                      onBack={() => changeMembersView(membersView === "add" ? "members" : null)}
                    />
                  ) : (
                    <ChannelSettingsTitle conversation={conversation} />
                  )}
                </SettingsPanelHeader>
                {membersView ? (
                  <div className="flex min-h-0 w-full flex-1 flex-col">
                    <ChannelMembersPage
                      channelId={channelId}
                      channelName={conversation.name}
                      viewerId={conversation.viewerId}
                      canCreateAgents={conversation.canCreateAgents}
                      view={membersView}
                      onViewChange={changeMembersView}
                      roster={{
                        search: rosterSearch,
                        onSearchChange: setRosterSearch,
                        onOpenProfile: openProfile,
                        returnFocus,
                      }}
                    />
                  </div>
                ) : (
                  <SlideoutMenu.Content className="gap-0 pb-6">
                    <MembersStrip
                      channelId={channelId}
                      canAdd={isMember && !conversation.archived}
                      onOpenMembers={() => setMembersView("members")}
                      onAddMembers={() => setMembersView("add")}
                    />
                    {capabilities.update && (
                      <PanelSection
                        title={m.channel_settings_info()}
                        description={m.channel_settings_info_description()}
                      >
                        <InfoForm
                          form={info}
                          channelName={conversation.name}
                          archived={conversation.archived}
                        />
                      </PanelSection>
                    )}
                    {capabilities.update && (
                      <CoordinatorSection conversation={conversation} onChanged={onChanged} />
                    )}
                    {isMember && (
                      <PreferencesSection conversation={conversation} onChanged={onChanged} />
                    )}
                    {(capabilities.archive ||
                      capabilities.unarchive ||
                      capabilities.leave ||
                      conversation.canHideGeneral ||
                      conversation.canStopAgents ||
                      conversation.canChangeVisibility ||
                      conversation.canDelete) && (
                      <ActionsSection
                        conversation={conversation}
                        onConfirm={setConfirming}
                        onStopAgents={() => setStoppingAgents(true)}
                        onChanged={onChanged}
                      />
                    )}
                  </SlideoutMenu.Content>
                )}
              </>
            )}
          </SlideoutDialog>
        </SlideoutModal>
      </SlideoutOverlay>
      <UnsavedChangesDialog
        open={unsavedPromptOpen}
        saving={info.saving}
        description={m.channel_settings_unsaved_message()}
        onKeepEditing={() => {
          afterClose.current = undefined;
          setUnsavedPromptOpen(false);
        }}
        onDiscard={() => {
          info.reset();
          setUnsavedPromptOpen(false);
          close();
        }}
        onSave={async () => {
          const saved = await info.save();
          setUnsavedPromptOpen(false);
          if (saved) close();
          else afterClose.current = undefined;
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
        onDone={async () => {
          setConfirming(null);
          onOpenChange(false);
          // After hiding #general or deleting the channel the page's refetch answers NOT_FOUND,
          // which leaves for Chat.
          await onChanged();
        }}
      />
    </>
  );
}

function CoordinatorSection({
  conversation,
  onChanged,
}: {
  conversation: ChannelConversationView;
  onChanged: () => Promise<void>;
}) {
  const toast = useAppToast();
  const setCoordinator = useServerFn(setPublicChannelCoordinator);
  const [saving, setSaving] = useState(false);
  const agents = (conversation.mentionables ?? []).filter(
    (entry) => entry.kind === "agent" && !entry.outsider,
  );
  const selected = conversation.coordinatorAgent
    ? `agent:${conversation.coordinatorAgent.id}`
    : "none";

  async function change(value: string) {
    setSaving(true);
    try {
      await setCoordinator({
        data: {
          channelId: conversation.conversationId,
          coordinatorAgentId: value === "none" ? null : value.slice("agent:".length),
        },
      });
      await onChanged();
    } catch {
      toast.error(m.channel_settings_coordinator_error());
    } finally {
      setSaving(false);
    }
  }

  return (
    <PanelSection title={m.channel_settings_coordinator_title()}>
      <EntityPickerField
        fieldLabel={m.channel_settings_coordinator_label()}
        label={m.channel_settings_coordinator_label()}
        hint={m.channel_settings_coordinator_hint()}
        selectedKey={selected}
        isDisabled={saving}
        options={[
          { id: "none", label: m.channel_settings_coordinator_none() },
          ...agents.map(memberOption),
        ]}
        onSelect={(key) => void change(key)}
      />
    </PanelSection>
  );
}

function PreferencesSection({
  conversation,
  onChanged,
}: {
  conversation: ChannelConversationView;
  onChanged: () => Promise<void>;
}) {
  const setPinned = useServerFn(setPublicConversationPinned);
  const actions = useSidebarActions();
  const setCollapse = useServerFn(setPublicChannelCollapseLongMessages);
  const [pending, setPending] = useState<"pin" | "mute" | "collapse" | null>(null);
  const [error, setError] = useState("");
  const channelId = conversation.conversationId;
  // The sidebar owns the mute (its row menu writes it too): its row is the truth, and its
  // optimistic action the write. The page's copy answers for a channel the sidebar does not list.
  const listed = useSidebarLists().channels.find((channel) => channel.id === channelId);
  const level = notificationLevelOf(listed ?? conversation);

  async function change(which: "pin" | "mute" | "collapse", write: () => Promise<unknown>) {
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
    <PanelSection title={m.channel_settings_preferences()}>
      <div className="divide-y divide-secondary">
        <PreferenceRow
          title={m.channel_settings_pin()}
          description={m.channel_settings_pin_description()}
        >
          <Toggle
            size="md"
            aria-label={m.channel_settings_pin()}
            isSelected={conversation.pinned}
            isDisabled={pending !== null}
            onChange={(pinned) =>
              void change("pin", () => setPinned({ data: { channelId, pinned } }))
            }
          />
        </PreferenceRow>
        {/* Four levels, as the row menu offers them (task #401): a switch could not say which level
            turning Mute off goes back to. */}
        <PreferenceRow title={m.channel_notify()} description={notificationLevelDescription(level)}>
          <Select
            aria-label={m.channel_notify()}
            size="sm"
            className="w-52"
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
        <PreferenceRow
          title={m.channel_settings_collapse_long_messages()}
          description={m.channel_settings_collapse_long_messages_description()}
        >
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
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-error-primary">
          {error}
        </p>
      )}
    </PanelSection>
  );
}
