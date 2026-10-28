import type { ReactNode } from "react";
import { Button } from "#src/components/base/buttons/button";
import { AgentHoverCard } from "#src/features/agents/agent-hover-card";
import type { OpenAgentProfile } from "#src/features/agents/profile-panel/open-agent-profile";
import { m } from "#src/paraglide/messages";
import type { MessageView } from "./message-view";

export function MessageSenderGutter({
  message,
  grouped,
  conversationId,
  openableAgentId,
  openablePersonId,
  onOpenAgentProfile,
  openSenderProfile,
  avatar,
  gutterTime,
  fullTime,
}: {
  message: Pick<MessageView, "createdAt" | "senderName" | "senderHandle" | "senderAvatarUrl">;
  grouped: boolean;
  conversationId?: string;
  openableAgentId?: string;
  openablePersonId?: string;
  onOpenAgentProfile?: OpenAgentProfile;
  openSenderProfile?: () => void;
  avatar: ReactNode;
  gutterTime: string;
  fullTime: string;
}) {
  return (
    <div className="flex w-9 shrink-0 items-start justify-center">
      {grouped ? (
        <time
          dateTime={new Date(message.createdAt).toISOString()}
          // The short gutter label is visible on hover; the full localized time remains available
          // to screen readers and the mobile action sheet. The explicit leading keeps the 12px
          // timestamp on the same 24px line as the message text.
          className="message-text text-xs leading-[var(--text-md--line-height)] whitespace-nowrap text-quaternary tabular-nums opacity-0 group-hover/message:opacity-100 group-focus-within/message:opacity-100"
        >
          <span aria-hidden="true">{gutterTime}</span>
          <span className="sr-only">{fullTime}</span>
        </time>
      ) : openableAgentId && onOpenAgentProfile ? (
        <AgentHoverCard
          agentId={openableAgentId}
          conversationId={conversationId}
          name={message.senderName}
          handle={message.senderHandle}
          src={message.senderAvatarUrl}
          trigger={avatar}
          onOpenProfile={onOpenAgentProfile}
        />
      ) : openablePersonId ? (
        <Button
          color="link-gray"
          noTextPadding
          aria-label={m.member_person_open_profile({ name: message.senderName })}
          className="shrink-0 rounded-full!"
          onPress={openSenderProfile}
        >
          {avatar}
        </Button>
      ) : (
        avatar
      )}
    </div>
  );
}
