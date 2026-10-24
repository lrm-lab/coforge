import { useQuery } from "@tanstack/react-query";

import { Badge } from "#src/components/base/badges/badges";
import { RelativeTime } from "#src/components/ui/relative-time";
import { AgentDisplayAvatar } from "#src/features/agents/agent-display-avatar";
import { getAgentPeerConversations } from "#src/features/agents/agent-peer-conversations.functions";
import { m } from "#src/paraglide/messages";
import { agentPeerConversationsQuery } from "./agent-profile-queries";
import { SECTION_CAPTION_CLASS } from "./inline-edit-field";

type AgentPeerCard = Awaited<ReturnType<typeof getAgentPeerConversations>>[number];

/**
 * The Profile tab's AGENT DMS section: the Agent's conversations with other Agents as cards, read
 * only. People are not members of these conversations, so nothing here opens, links or answers
 * one. The section is absent until the read arrives, and stays absent when it is empty or fails.
 */
export function AgentPeerDmsSection({
  agentId,
  agentName,
  timeZone,
}: {
  agentId: string;
  agentName: string;
  timeZone: string | null;
}) {
  const query = useQuery(agentPeerConversationsQuery(agentId));
  return query.data ? (
    <AgentPeerDmList cards={query.data} agentName={agentName} timeZone={timeZone} />
  ) : null;
}

/** The cards themselves, newest first as the server sends them; nothing at all for no cards. */
export function AgentPeerDmList({
  cards,
  agentName,
  timeZone,
}: {
  cards: AgentPeerCard[];
  /** The display name of the Agent whose panel this is, for the lines it wrote last. */
  agentName: string;
  timeZone: string | null;
}) {
  if (cards.length === 0) return null;
  return (
    <section className="border-b border-secondary px-6 py-5">
      <p className={SECTION_CAPTION_CLASS}>{m.agent_profile_section_peer_dms()}</p>
      <ul className="mt-3 flex flex-col gap-3">
        {cards.map((card) => {
          const peerName = card.peer.displayName || card.peer.name;
          return (
            <li key={card.peer.agentId} className="flex min-w-0 items-start gap-2.5">
              <AgentDisplayAvatar
                agentId={card.peer.agentId}
                name={peerName}
                src={card.peer.avatar}
                cornerDot={false}
              />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5 text-sm">
                  <span className="truncate font-medium text-primary">{peerName}</span>
                  <span className="truncate text-tertiary">@{card.peer.name}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {card.limited && (
                      <Badge size="sm" color="warning">
                        {m.agent_peer_dm_paused()}
                      </Badge>
                    )}
                    <RelativeTime
                      value={card.lastMessageAt}
                      timeZone={timeZone}
                      plain
                      className="text-xs text-tertiary"
                    />
                  </span>
                </div>
                <p className="mt-0.5 truncate text-sm text-tertiary">
                  {m.agent_peer_dm_last_line({
                    speaker: card.lastFromPeer ? peerName : agentName,
                    preview: card.preview,
                  })}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
