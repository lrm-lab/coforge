import { Button as AriaButton } from "react-aria-components";
import { useMemo } from "react";

import { Button } from "#src/components/base/buttons/button";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { AgentMascotAvatar } from "#src/features/agents/agent-mascot-avatar";
import { agentDisplay } from "#src/features/agents/agent-status-display";
import { AgentStatusMarker, AgentStatusText } from "#src/features/agents/agent-status-marker";
import { DELETED_AGENT_NAME_CLASS, DeletedAgentLabel } from "#src/features/agents/deleted-agent";
import { useLiveAgent, useLiveAgentDisplay } from "#src/features/agents/workspace-agents-realtime";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { TabbedHeader } from "#src/components/layout/tabbed-header";
import { DirectSettingsPanel, DirectSettingsToggleButton } from "./direct-settings-panel";
import { useConversationDetailsState } from "./use-conversation-details-state";
import { ConversationFocusButton } from "./conversation-focus-button";
import { conversationHeaderTabs, type HeaderTabs } from "./conversation-header-tabs";
import { ConversationListButton } from "./conversation-list-button";
import { DirectThreadedConversation } from "./direct-threaded-conversation";
import { plainMentionsByHandle } from "./message-markdown";
import type {
  ConversationProps,
  DirectConversationView,
  ThreadedConversationProps,
} from "./conversation-types";

export function DirectConversationHeader({
  conversation,
  onOpenAgentProfile,
  settingsOpen = false,
  onToggleSettings,
  ...tabs
}: HeaderTabs & {
  conversation: DirectConversationView;
  onOpenAgentProfile?: (agentId: string) => void;
  settingsOpen?: boolean;
  onToggleSettings?: () => void;
}) {
  const live = useLiveAgent(conversation.agent.id);
  const display = useLiveAgentDisplay(conversation.agent.id);
  const status = agentDisplay(display);
  // A deleted Agent's DM stays readable, with its read-only profile, but takes no new messages.
  const deleted = Boolean(conversation.agent.deletedAt);
  const openProfile = onOpenAgentProfile
    ? () => onOpenAgentProfile(conversation.agent.id)
    : undefined;
  // The moving mascot wherever the live store knows the Agent's key: the viewer's own Agents and
  // another member's (`isExtra`, once watched above). The still picture stays for a deleted Agent
  // (greyed), an Agent whose mascot is not known yet (no live entry, no profile mascot) and an app
  // bot, which has no mascot.
  const avatar = live?.mascot ? (
    <AgentMascotAvatar
      mascot={live.mascot}
      name={conversation.agent.displayName}
      display={display}
      deleted={deleted}
      announced
    />
  ) : (
    <AgentDisplayAvatar
      agentId={conversation.agent.id}
      name={conversation.agent.displayName}
      src={conversation.agent.avatarUrl}
      display={display}
      deleted={deleted}
      cornerDot={false}
    />
  );
  return (
    <TabbedHeader
      identity={
        <>
          <ConversationListButton />
          {/* No hover card here: the card belongs to the avatars in the message stream. */}
          {openProfile ? (
            <Button
              color="tertiary"
              noTextPadding
              aria-label={m.agent_open_profile({ name: conversation.agent.displayName })}
              onPress={openProfile}
              className="h-auto w-auto shrink-0 rounded-full p-0 hover:bg-transparent"
            >
              {avatar}
            </Button>
          ) : (
            avatar
          )}
          {/* One line: name, then the live status as a dot and a label. */}
          <div
            className={cn(
              "flex min-w-0 flex-1",
              // A warning takes a line of its own: the name keeps its width.
              status.alert ? "flex-col items-start [&_h1]:leading-5" : "items-center gap-2",
            )}
          >
            {openProfile ? (
              <AriaButton
                onPress={openProfile}
                aria-label={m.agent_open_profile({ name: conversation.agent.displayName })}
                className={cn(
                  "min-w-0 cursor-pointer rounded text-left text-md font-semibold outline-focus-ring hover:underline focus-visible:outline-2 focus-visible:outline-offset-2",
                  deleted ? DELETED_AGENT_NAME_CLASS : "text-primary",
                )}
              >
                <h1 className="truncate">{conversation.agent.displayName}</h1>
              </AriaButton>
            ) : (
              <h1
                className={cn(
                  "min-w-0 truncate text-md font-semibold",
                  deleted && DELETED_AGENT_NAME_CLASS,
                )}
              >
                {conversation.agent.displayName}
              </h1>
            )}
            {deleted ? (
              <DeletedAgentLabel />
            ) : (
              <div className={status.alert ? "flex w-full min-w-0 items-center gap-1" : "contents"}>
                <AgentStatusMarker status={status} className="size-2" />
                <p
                  role="status"
                  className={cn(
                    status.alert
                      ? "min-w-0 truncate text-xs text-error-primary"
                      : "min-w-0 flex-1 truncate text-sm text-tertiary",
                  )}
                >
                  <AgentStatusText status={status} />
                </p>
              </div>
            )}
          </div>
        </>
      }
      actions={
        // The -mr-1.5 cancels the button's p-1.5 so its glyph lands on the pane gutter, as in the
        // channel header.
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

export function DirectConversation({
  onChanged,
  ...props
}: ConversationProps &
  Pick<
    ThreadedConversationProps,
    "channels" | "taskPopup" | "jumpMessage" | "onJumpMessageConsumed"
  > & {
    onChanged: () => Promise<void>;
  }) {
  const { conversation } = props;
  const details = useConversationDetailsState({ enabled: !props.taskPopup });
  // A deleted Agent's DM stays readable, but nothing new can be sent to it.
  const deleted = Boolean(conversation.agent.deletedAt);
  // A private Agent's DM stays scoped to its own creator; this viewer's existing DM
  // reads read-only. Independent of, and checked after, the deletion case above.
  const dmRestricted = !deleted && conversation.dmWritable === false;
  // A DM carries no member directory: its only member counterpart is the conversation's own
  // Agent, whose messages keep plain text by design. Chip that one handle (display-only) so the
  // stream still reads the Agent's display label.
  const agentName = conversation.agent.displayName?.trim() || conversation.agent.name;
  const plainMentions = useMemo(
    () =>
      deleted
        ? undefined
        : plainMentionsByHandle([
            {
              kind: "agent",
              id: conversation.agent.id,
              handle: conversation.agent.name,
              label: agentName,
            },
          ]),
    [deleted, conversation.agent.id, conversation.agent.name, agentName],
  );
  return (
    <DirectThreadedConversation
      {...props}
      name={agentName}
      threadContext={`@${conversation.agent.name}`}
      plainMentions={plainMentions}
      detailsOpen={details.open}
      detailsPane={
        <DirectSettingsPanel
          conversationId={conversation.conversationId}
          name={conversation.agent.displayName}
          avatar={
            <AgentDisplayAvatar
              agentId={conversation.agent.id}
              name={conversation.agent.displayName}
              src={conversation.agent.avatarUrl}
              cornerDot={false}
            />
          }
          open={details.open}
          onClose={details.closeDetails}
          collapseLongMessages={conversation.collapseLongMessages}
          onChanged={onChanged}
        />
      }
      header={
        <DirectConversationHeader
          conversation={conversation}
          active="chat"
          onShowTasks={props.onShowTasks}
          onShowFiles={props.onShowFiles}
          onOpenAgentProfile={props.onOpenAgentProfile}
          settingsOpen={details.open}
          onToggleSettings={details.toggleDetails}
        />
      }
      readOnlyNotice={
        deleted ? (
          <div className="mx-4 mb-4 rounded-lg border border-secondary bg-secondary p-4 md:mx-6 md:mb-6">
            <p className="text-sm text-tertiary">{m.agent_deleted_conversation_notice()}</p>
          </div>
        ) : dmRestricted ? (
          <div className="mx-4 mb-4 rounded-lg border border-secondary bg-secondary p-4 md:mx-6 md:mb-6">
            <p className="text-sm text-tertiary">{m.agent_dm_restricted_notice()}</p>
          </div>
        ) : undefined
      }
      emptyState={{
        title: m.conversation_empty_title({ name: conversation.agent.displayName }),
        description: m.conversation_empty_description(),
        avatar: { name: conversation.agent.displayName, src: conversation.agent.avatarUrl },
      }}
    />
  );
}

// Keep the feature's public seam stable while the implementation is split by responsibility.
export { ConversationPane } from "./conversation-pane";
export { ThreadedConversation } from "./threaded-conversation";
export type {
  ConversationProps,
  DirectConversationView,
  TaskPopupControls,
  ThreadedConversationProps,
} from "./conversation-types";
