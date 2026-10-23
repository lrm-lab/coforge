import { useMemo } from "react";
import { getRouteApi } from "@tanstack/react-router";

import { TabbedHeader } from "#src/components/layout/tabbed-header";
import { MemberAvatar } from "#src/features/workspaces/member-avatar";
import { useMemberOnline } from "#src/features/workspaces/member-presence";
import { m } from "#src/paraglide/messages";
import { conversationHeaderTabs, type HeaderTabs } from "./conversation-header-tabs";
import { ConversationListButton } from "./conversation-list-button";
import { DirectSettingsButton } from "./direct-settings-panel";
import type { ThreadedConversationProps } from "./conversation-types";
import { DirectThreadedConversation } from "./direct-threaded-conversation";
import { plainMentionsByHandle } from "./message-markdown";
import type { useDirectConversation } from "./use-conversation-data";

/** A direct conversation between Workspace members, as its page loads it. */
export type PeopleDirectConversationView = Extract<
  ReturnType<typeof useDirectConversation>["page"]["conversation"],
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
  onChanged,
  ...tabs
}: HeaderTabs & {
  conversation: PeopleDirectConversationView;
  /** Re-reads the page after the settings panel changed a preference. */
  onChanged: () => Promise<void>;
}) {
  const { peer } = conversation;
  const online = useMemberOnline(peer.id);
  const self = useIsSelfConversation(conversation);
  return (
    <TabbedHeader
      identity={
        <>
          <ConversationListButton />
          <MemberAvatar size="sm" userId={peer.id} name={peer.displayName} src={peer.avatarUrl} />
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
        // The -mr-1.5 cancels the button's p-1.5 so its glyph lands on the pane gutter, as in the
        // channel header.
        <div className="-mr-1.5 flex shrink-0 items-center">
          <DirectSettingsButton
            conversationId={conversation.conversationId}
            name={peer.displayName}
            collapseLongMessages={conversation.collapseLongMessages}
            onChanged={onChanged}
          />
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
> & { conversation: PeopleDirectConversationView; onChanged: () => Promise<void> }) {
  const { peer } = conversation;
  const self = useIsSelfConversation(conversation);
  const { mentionables } = conversation;
  const plainMentions = useMemo(() => plainMentionsByHandle(mentionables), [mentionables]);
  return (
    <DirectThreadedConversation
      {...props}
      conversation={conversation}
      mentionCompletion={false}
      name={peer.displayName}
      plainMentions={plainMentions}
      header={
        <PeopleDirectConversationHeader
          conversation={conversation}
          active="chat"
          onShowTasks={props.onShowTasks}
          onShowFiles={props.onShowFiles}
          onChanged={onChanged}
        />
      }
      emptyState={{
        title: self
          ? m.people_dm_self_empty_title()
          : m.conversation_empty_title({ name: peer.displayName }),
        description: self
          ? m.people_dm_self_empty_description()
          : m.people_dm_empty_description({ name: peer.displayName }),
        avatar: { name: peer.displayName, src: peer.avatarUrl },
      }}
    />
  );
}
