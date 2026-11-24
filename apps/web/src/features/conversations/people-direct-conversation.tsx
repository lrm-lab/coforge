import { useMemo } from "react";
import { ActorAvatar } from "#src/features/avatars/actor-avatar";
import { getRouteApi } from "@tanstack/react-router";

import { TabbedHeader } from "#src/components/layout/tabbed-header";
import { useMemberOnline } from "#src/features/workspaces/member-presence";
import { m } from "#src/paraglide/messages";
import { ConversationFocusButton } from "./conversation-focus-button";
import { conversationHeaderTabs, type HeaderTabs } from "./conversation-header-tabs";
import { ConversationListButton } from "./conversation-list-button";
import { DirectSettingsPanel, DirectSettingsToggleButton } from "./direct-settings-panel";
import { useConversationDetailsState } from "./use-conversation-details-state";
import type { ThreadedConversationProps } from "./conversation-types";
import { DirectThreadedConversation } from "./direct-threaded-conversation";
import { plainMentionsByHandle } from "./message-markdown";
import type { useDirectConversation } from "./use-conversation-data";

/** A direct conversation between Workspace members, as its page loads it. */
export type PeopleDirectConversationView = Extract<
  ReturnType<typeof useDirectConversation>["conversation"],
  { kind: "people" }
>;

const appRoute = getRouteApi("/w/$workspaceSlug");

/** Whether this is the viewer's conversation with themself. */
function useIsSelfConversation(conversation: PeopleDirectConversationView) {
  return appRoute.useLoaderData({ select: ({ user }) => user.id }) === conversation.peer.id;
}

/**
 * The header of a direct message between members: the member (with their presence, and "(you)" in
 * the viewer's conversation with themself) and the conversation tabs.
 */
export function PeopleDirectConversationHeader({
  conversation,
  settingsOpen = false,
  onToggleSettings,
  ...tabs
}: HeaderTabs & {
  conversation: PeopleDirectConversationView;
  settingsOpen?: boolean;
  onToggleSettings?: () => void;
}) {
  const { peer } = conversation;
  const online = useMemberOnline(peer.id);
  const self = useIsSelfConversation(conversation);
  return (
    <TabbedHeader
      identity={
        <>
          <ConversationListButton />
          <ActorAvatar
            presence
            size="sm"
            userId={peer.id}
            name={peer.displayName}
            src={peer.avatarUrl}
          />
          <h1 className="min-w-0 flex-1 truncate text-md font-semibold">
            {peer.displayName}
            {self && (
              <span className="font-normal text-tertiary">{m.conversation_dm_self_suffix()}</span>
            )}
            {online !== undefined && (
              <span className="sr-only">, {online ? m.member_online() : m.member_offline()}</span>
            )}
          </h1>
        </>
      }
      actions={
        <div className="-mr-1.5 flex shrink-0 items-center gap-3">
          <ConversationFocusButton />
          {onToggleSettings && (
            <DirectSettingsToggleButton open={settingsOpen} onToggle={onToggleSettings} />
          )}
        </div>
      }
      tabs={conversationHeaderTabs(tabs)}
    />
  );
}

/**
 * A direct message between members: always writable, with no Agent in it. The composer offers no
 * @-completion here (a mention in a member DM is kept as plain text); the two members' handles
 * still read as their names in the stream.
 */
export function PeopleDirectConversation({
  conversation,
  onChanged,
  ...props
}: Omit<
  ThreadedConversationProps,
  "conversation" | "header" | "emptyState" | "conversationName" | "threadContext"
> & {
  conversation: PeopleDirectConversationView;
  onChanged: () => Promise<void>;
}) {
  const { peer } = conversation;
  const self = useIsSelfConversation(conversation);
  const { mentionables } = conversation;
  const plainMentions = useMemo(() => plainMentionsByHandle(mentionables), [mentionables]);
  const details = useConversationDetailsState({ enabled: !props.taskPopup });
  // Nobody else is in a conversation with yourself, so its messages carry no read ticks.
  const shown = useMemo(
    () => (self ? { ...conversation, readTicks: undefined } : conversation),
    [self, conversation],
  );
  return (
    <DirectThreadedConversation
      {...props}
      conversation={shown}
      mentionCompletion={false}
      name={peer.displayName}
      plainMentions={plainMentions}
      detailsOpen={details.open}
      detailsPane={
        <DirectSettingsPanel
          conversationId={conversation.conversationId}
          name={peer.displayName}
          avatar={
            <ActorAvatar
              presence
              size="sm"
              userId={peer.id}
              name={peer.displayName}
              src={peer.avatarUrl}
            />
          }
          open={details.open}
          onClose={details.closeDetails}
          collapseLongMessages={conversation.collapseLongMessages}
          onChanged={onChanged}
        />
      }
      header={
        <PeopleDirectConversationHeader
          conversation={conversation}
          active="chat"
          onShowTasks={props.onShowTasks}
          onShowFiles={props.onShowFiles}
          settingsOpen={details.open}
          onToggleSettings={details.toggleDetails}
        />
      }
      emptyState={{
        title: self
          ? m.people_dm_self_empty_title()
          : m.conversation_empty_title({ name: peer.displayName }),
        description: self
          ? m.people_dm_self_empty_description()
          : m.people_dm_empty_description({ name: peer.displayName }),
        avatar: { name: peer.displayName, src: peer.avatarUrl, userId: peer.id },
      }}
    />
  );
}
