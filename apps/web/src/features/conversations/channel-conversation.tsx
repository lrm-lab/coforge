import { useCallback, useMemo, useState, type MutableRefObject, type ReactNode } from "react";
import { Button as AriaButton } from "react-aria-components";
import { useOpenSearch } from "#src/features/search/search-dialog-context";
import { useQuery } from "@tanstack/react-query";
import { SearchLg, Settings01 as Settings } from "@untitledui/icons";
import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { cn } from "#src/lib/utils";
import { ChannelFace, ChannelTitle, channelGlyph } from "./channel-name";
import { ChannelSettingsPanel } from "./channel-settings-panel";
import { channelLabel, isPrivateChannel, type ChannelVisibility } from "./channel-visibility";
import { ChannelHeaderMemberCluster } from "./channel-header-people";
import type { ChannelMembersView } from "./channel-members-page";
import type { ChannelCapabilities } from "#src/server/conversations/channel-authority.server";
import { TabbedHeader } from "#src/components/layout/tabbed-header";
import { ConversationFocusButton } from "./conversation-focus-button";
import { ConversationListButton } from "./conversation-list-button";
import { ThreadFollowingAgents } from "./thread-following-agents";
import {
  conversationHeaderTabs,
  HEADER_ICON_CLASS,
  type HeaderTabs,
} from "./conversation-header-tabs";
import type { SendOptions } from "./composer-outbox";
import type { SentMessage } from "./message-composer";
import { plainMentionsByHandle } from "./message-markdown";
import { channelMentionOutsidersQuery, readsMentionOutsiders } from "./channel-page-reads";
import { useChannelMentionables } from "./use-channel-mentionables";
import {
  ThreadedConversation,
  type DirectConversationView,
  type TaskPopupControls,
} from "./direct-conversation";
import type { ChannelSuggestion } from "./reference-completion";
import { m } from "#src/paraglide/messages";
import { ChannelAgentsContext } from "#src/features/agents/channel-agents-context";
import type { AgentProfileTab } from "#src/features/agents/profile-panel/profile-panel-search";
import type { ConversationProps } from "./conversation-types";
import type { ChannelNotificationLevel } from "./notification-levels";
import type { OpenAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import { useConversationDetailsState } from "./use-conversation-details-state";

export type ChannelConversationView = Omit<DirectConversationView, "agent" | "messages"> & {
  name: string;
  description: string;
  archived: boolean;
  visibility: ChannelVisibility;
  coordinatorAgent?: { id: string; name: string; displayName: string };
  muted: boolean;
  notificationLevel?: ChannelNotificationLevel;
  pinned: boolean;
  channelCapabilities: ChannelCapabilities;
  canHideGeneral: boolean;
  canDelete: boolean;
  canCreateAgents: boolean;
  canStopAgents: boolean;
  canChangeVisibility?: boolean;
  followedThreadRootIds?: string[];
  messages: DirectConversationView["messages"];
};

export function ChannelConversationHeader({
  conversation,
  settingsOpen = false,
  onOpenSettings,
  onCloseSettings,
  ...tabs
}: HeaderTabs & {
  conversation: ChannelConversationView;
  settingsOpen?: boolean;
  onOpenSettings?: (view?: ChannelMembersView | null) => void;
  onCloseSettings?: () => void;
}) {
  const openSearch = useOpenSearch();
  const canInvite = Boolean(conversation.senderMemberId) && !conversation.archived;
  const toggleSettings = () => {
    if (settingsOpen) onCloseSettings?.();
    else onOpenSettings?.(null);
  };
  return (
    <TabbedHeader
      identity={
        <>
          <ConversationListButton />
          <h1 data-channel-title className="flex min-w-0 flex-1 items-center text-md font-semibold">
            {onOpenSettings ? (
              <AriaButton
                onPress={toggleSettings}
                aria-expanded={settingsOpen}
                className="flex min-w-0 max-w-full cursor-pointer items-center gap-2 rounded-sm text-left outline-focus-ring hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                <ChannelFace
                  channelId={conversation.conversationId}
                  className="avatar-group-header"
                  fallback={null}
                />
                <span data-channel-name className="min-w-0 truncate">
                  <ChannelTitle
                    name={conversation.name}
                    visibility={conversation.visibility}
                    hash={false}
                  />
                </span>
              </AriaButton>
            ) : (
              <span className="flex min-w-0 items-center gap-2">
                <ChannelFace
                  channelId={conversation.conversationId}
                  className="avatar-group-header"
                  fallback={null}
                />
                <span data-channel-name className="min-w-0 truncate">
                  <ChannelTitle
                    name={conversation.name}
                    visibility={conversation.visibility}
                    hash={false}
                  />
                </span>
              </span>
            )}
          </h1>
        </>
      }
      actions={
        <div className="-mr-1.5 flex shrink-0 items-center gap-3">
          <ButtonUtility
            icon={SearchLg}
            size="sm"
            color="tertiary"
            className={HEADER_ICON_CLASS}
            tooltip={m.search_this_channel()}
            onClick={() =>
              openSearch({
                filters: { channelId: conversation.conversationId },
                deferred: true,
              })
            }
          />
          <ChannelHeaderMemberCluster
            channelId={conversation.conversationId}
            canAdd={canInvite}
            onOpenMembers={() => onOpenSettings?.("members")}
            onAddMembers={() => onOpenSettings?.("add")}
          />
          <ConversationFocusButton />
          <ButtonUtility
            icon={Settings}
            size="sm"
            color="tertiary"
            aria-expanded={settingsOpen}
            className={cn(HEADER_ICON_CLASS, settingsOpen && "bg-primary_hover")}
            tooltip={m.channel_settings_open()}
            onClick={toggleSettings}
          />
        </div>
      }
      tabs={conversationHeaderTabs(tabs)}
    />
  );
}

export function ChannelConversation({
  conversation,
  onSend,
  onJoin,
  onChanged,
  onLoadOlder,
  onLoadNewer,
  onLoadMessageAround,
  onShowLatest,
  onReadThread,
  onReadLatest,
  onThreadFollowedChange,
  canSendAsTask,
  onToggleReaction,
  onShowTasks,
  onShowFiles,
  onOpenAgentProfile,
  onOpenPersonProfile,
  agentProfile,
  onAgentProfileTabChange,
  onCloseAgentProfile,
  tasksPane,
  channels,
  taskPopup,
  jumpMessage,
  onJumpMessageConsumed,
  settingsOpen: controlledSettingsOpen,
  onSettingsOpenChange: onControlledSettingsOpenChange,
  requestedMembersView: controlledMembersView,
  onRequestedMembersViewConsumed: onControlledMembersViewConsumed,
  detailsRequestCloseRef,
}: {
  conversation: ChannelConversationView;
  onSend: (
    body: string,
    idempotencyKey: string,
    attachmentIds?: string[],
    options?: SendOptions,
  ) => Promise<SentMessage | void>;
  onJoin: () => Promise<void>;
  onChanged: () => Promise<void>;
  onLoadOlder?: () => Promise<void>;
  onLoadNewer?: () => Promise<void>;
  onLoadMessageAround?: (messageId: string) => Promise<string>;
  onShowLatest?: () => Promise<void>;
  onReadThread?: (rootMessageId: string, throughSequence: number) => Promise<void>;
  onReadLatest?: (throughSequence: number) => void;
  onThreadFollowedChange?: (rootMessageId: string, followed: boolean) => Promise<void>;
  canSendAsTask?: boolean;
  onToggleReaction?: (messageId: string, emoji: string, active: boolean) => Promise<void>;
  onShowTasks?: () => void;
  onShowFiles?: () => void;
  onOpenAgentProfile?: OpenAgentProfile;
  onOpenPersonProfile?: ConversationProps["onOpenPersonProfile"];
  agentProfile?: ConversationProps["agentProfile"];
  onAgentProfileTabChange?: (tab: AgentProfileTab) => void;
  onCloseAgentProfile?: () => void;
  tasksPane?: ReactNode;
  channels?: readonly ChannelSuggestion[];
  taskPopup?: TaskPopupControls;
  jumpMessage?: string;
  onJumpMessageConsumed?: () => void;
  settingsOpen?: boolean;
  onSettingsOpenChange?: (open: boolean) => void;
  requestedMembersView?: ChannelMembersView | null;
  onRequestedMembersViewConsumed?: () => void;
  detailsRequestCloseRef?: MutableRefObject<((then?: () => void) => void) | null>;
}) {
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState(false);
  const [ownMembersView, setOwnMembersView] = useState<ChannelMembersView | null>(null);
  const details = useConversationDetailsState({
    controlledOpen: controlledSettingsOpen,
    onControlledOpenChange: onControlledSettingsOpenChange,
    requestCloseRef: detailsRequestCloseRef,
  });
  const activeRequestCloseRef = details.requestCloseRef;
  const requestedMembersView = controlledMembersView ?? ownMembersView;
  const consumeMembersView = useCallback(() => {
    setOwnMembersView(null);
    onControlledMembersViewConsumed?.();
  }, [onControlledMembersViewConsumed]);
  const openSettings = (view: ChannelMembersView | null = null) => {
    if (view) setOwnMembersView(view);
    details.openDetails();
  };
  const freshMentionables = useChannelMentionables(
    conversation.conversationId,
    conversation.mentionables,
  );
  const mentionOutsiders = useQuery({
    ...channelMentionOutsidersQuery(conversation.conversationId),
    enabled: readsMentionOutsiders(conversation),
  });
  const conversationWithFreshDirectory = useMemo(
    () => ({
      ...conversation,
      mentionables: freshMentionables ?? conversation.mentionables,
      mentionOutsiders: mentionOutsiders.data,
    }),
    [conversation, freshMentionables, mentionOutsiders.data],
  );
  const directory = conversationWithFreshDirectory.mentionables;
  const conversationId = conversation.conversationId;
  const channelAgents = useMemo(
    () =>
      directory && {
        conversationId,
        agentIds: directory.filter(({ kind }) => kind === "agent").map(({ id }) => id),
        onOpenAgentProfile,
      },
    [directory, conversationId, onOpenAgentProfile],
  );
  async function join() {
    setJoining(true);
    setError(false);
    try {
      await onJoin();
    } catch {
      setError(true);
    } finally {
      setJoining(false);
    }
  }
  const plainMentions = useMemo(
    () => plainMentionsByHandle(conversationWithFreshDirectory.mentionables),
    [conversationWithFreshDirectory.mentionables],
  );
  const priv = isPrivateChannel(conversation);
  const Glyph = channelGlyph(conversation);
  const threaded = (
    <ThreadedConversation
      conversation={conversationWithFreshDirectory}
      conversationName={channelLabel(conversation)}
      plainMentions={plainMentions}
      onSend={onSend}
      onLoadOlder={onLoadOlder}
      onLoadNewer={onLoadNewer}
      onLoadMessageAround={onLoadMessageAround}
      onShowLatest={onShowLatest}
      onReadThread={onReadThread}
      onReadLatest={onReadLatest}
      onOpenAgentProfile={onOpenAgentProfile}
      onOpenPersonProfile={onOpenPersonProfile}
      agentProfile={agentProfile}
      onAgentProfileTabChange={onAgentProfileTabChange}
      onCloseAgentProfile={onCloseAgentProfile}
      tasksPane={tasksPane}
      detailsOpen={details.open}
      onRequestCloseDetails={details.requestClose}
      detailsPane={
        <ChannelSettingsPanel
          conversation={conversationWithFreshDirectory}
          open={details.open}
          requestedMembersView={requestedMembersView}
          onRequestedMembersViewConsumed={consumeMembersView}
          requestCloseRef={activeRequestCloseRef}
          onOpenChange={details.setOpen}
          onChanged={onChanged}
        />
      }
      channels={channels}
      taskPopup={taskPopup}
      jumpMessage={jumpMessage}
      onJumpMessageConsumed={onJumpMessageConsumed}
      canSendAsTask={Boolean(conversation.senderMemberId) && canSendAsTask}
      onToggleReaction={conversation.senderMemberId ? onToggleReaction : undefined}
      threadContext={channelLabel(conversation)}
      threadHeaderAction={(rootMessageId) => (
        <ThreadFollowingAgents
          channelId={conversation.conversationId}
          threadRootId={rootMessageId}
          onOpenAgentProfile={onOpenAgentProfile}
        />
      )}
      threadFollow={(rootMessageId) =>
        conversation.senderMemberId
          ? {
              followed: conversation.followedThreadRootIds?.includes(rootMessageId) ?? false,
              onChange: (followed) => void onThreadFollowedChange?.(rootMessageId, followed),
            }
          : undefined
      }
      emptyState={{
        title: conversation.name,
        description: !conversation.senderMemberId
          ? m.channel_empty_preview()
          : priv
            ? m.channel_empty_private()
            : m.channel_empty(),
        media: (
          <ChannelFace
            channelId={conversation.conversationId}
            fallback={
              <Glyph aria-hidden="true" className="size-12 text-tertiary" strokeWidth={1.5} />
            }
          />
        ),
      }}
      header={
        <ChannelConversationHeader
          conversation={conversationWithFreshDirectory}
          active="chat"
          onShowTasks={onShowTasks}
          onShowFiles={onShowFiles}
          settingsOpen={details.open}
          onOpenSettings={openSettings}
          onCloseSettings={() => details.requestClose()}
        />
      }
      readOnlyNotice={
        conversation.archived ? (
          <ArchivedChannelNotice
            canUnarchive={conversation.channelCapabilities.unarchive && !taskPopup}
            onOpenSettings={() => openSettings(null)}
          />
        ) : !conversation.senderMemberId ? (
          <div className="mx-4 mb-4 flex flex-col items-start gap-3 rounded-lg border border-secondary bg-secondary p-4 md:mx-6 md:mb-6">
            <p className="text-sm text-tertiary">{m.channel_public_description()}</p>
            {error && (
              <p role="alert" className="text-sm text-error-primary">
                {m.channel_error()}
              </p>
            )}
            <Button isDisabled={joining} onPress={() => void join()}>
              {joining ? m.channel_joining() : m.channel_join()}
            </Button>
          </div>
        ) : undefined
      }
    />
  );
  return <ChannelAgentsContext value={channelAgents}>{threaded}</ChannelAgentsContext>;
}

function ArchivedChannelNotice({
  canUnarchive,
  onOpenSettings,
}: {
  canUnarchive: boolean;
  onOpenSettings: () => void;
}) {
  return (
    <div className="mx-4 mb-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border border-secondary bg-secondary p-4 text-sm md:mx-6 md:mb-6">
      <span className="font-medium text-primary">{m.channel_archived_notice()}</span>
      {canUnarchive && (
        <Button color="link-color" size="sm" onPress={onOpenSettings}>
          {m.channel_archived_unarchive()}
        </Button>
      )}
    </div>
  );
}
