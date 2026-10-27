import { Badge } from "#src/components/base/badges/badges";
import { Tooltip, TooltipTrigger } from "#src/components/base/tooltip/tooltip";
import { RelativeTime } from "#src/components/ui/relative-time";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import type { getAgentPeerConversations } from "#src/features/agents/agent-peer-conversations.functions";
import { MessageBody } from "#src/features/conversations/message-body";
import { m } from "#src/paraglide/messages";

export type AgentPeerCard = Awaited<ReturnType<typeof getAgentPeerConversations>>[number];

/**
 * The Chat tab's Agent DMs: the Agent's conversations with other Agents as read-only cards. People
 * are not members of these conversations, so nothing here opens, links or answers one. The server
 * sends them in order: those with a message first, newest first.
 */
export function AgentPeerDmList({
  cards,
  timeZone,
}: {
  cards: AgentPeerCard[];
  timeZone: string | null;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {cards.map((card) => {
        const peerName = card.peer.displayName || card.peer.name;
        return (
          <li
            key={card.peer.agentId}
            className="flex min-w-0 flex-col gap-2 rounded-xl border border-secondary bg-primary p-3"
          >
            <div className="flex min-w-0 items-center gap-2.5 text-xs">
              <span className="shrink-0 text-tertiary">{m.agent_peer_dm_badge()}</span>
              <AgentDisplayAvatar
                agentId={card.peer.agentId}
                name={peerName}
                src={card.peer.avatar}
                size="xs"
                cornerDot={false}
              />
              <span className="min-w-0 shrink truncate text-sm font-semibold text-primary">
                {peerName}
              </span>
              <span className="min-w-0 shrink-[3] truncate font-mono text-xs text-tertiary">
                @{card.peer.name}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {card.limited && (
                  <Badge size="sm" color="warning">
                    {m.agent_peer_dm_paused()}
                  </Badge>
                )}
                <RelativeTime
                  value={card.at}
                  timeZone={timeZone}
                  plain
                  className="font-mono text-xs text-tertiary"
                />
              </span>
            </div>
            {card.message ? (
              // `message-text` puts the preview on the message type scale, as in a conversation.
              <div className="message-text line-clamp-3 min-w-0 text-secondary">
                <MessageBody body={card.message.body} mentions={card.message.mentions} />
              </div>
            ) : (
              <p className="text-sm text-tertiary">{m.agent_peer_dm_no_messages()}</p>
            )}
            <Tooltip title={m.agent_peer_dm_activity_tooltip()}>
              <TooltipTrigger className="self-start font-mono text-xs text-quaternary">
                {m.agent_peer_dm_activity_only()}
              </TooltipTrigger>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
