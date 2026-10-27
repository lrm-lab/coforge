import type { ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { Hash01, MessageChatCircle } from "@untitledui/icons";

import { Alert } from "#src/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "#src/components/ui/empty";
import { m } from "#src/paraglide/messages";
import { AgentChannelList } from "./agent-chat-channels";
import { AgentPeerDmList } from "./agent-peer-dms-section";
import { agentChannelsQuery, agentPeerConversationsQuery } from "./agent-profile-queries";
import { SECTION_CAPTION_CLASS } from "./inline-edit-field";

/**
 * The Chat tab: the channels the Agent is in and its conversations with other Agents, one read
 * each. The server answers both only to the viewers the tab is shown to.
 */
export function AgentChatTab({ agentId, timeZone }: { agentId: string; timeZone: string | null }) {
  const channelsQuery = useQuery(agentChannelsQuery(agentId));
  const peersQuery = useQuery(agentPeerConversationsQuery(agentId));
  const channels = channelsQuery.data;
  const peers = peersQuery.data;

  // The heading bar stays over every state, as on Raft; the body below it changes.
  return (
    <div>
      <h2 className="border-b border-secondary px-5 py-3 text-xs font-medium text-secondary">
        {m.agent_chat_heading()}
      </h2>
      {channelsQuery.isError || peersQuery.isError ? (
        <Alert color="warning" description={m.agent_chat_error()} className="m-5" />
      ) : !channels || !peers ? (
        <p className="px-5 py-4 text-sm text-tertiary">{m.agent_chat_loading()}</p>
      ) : channels.length === 0 && peers.length === 0 ? (
        <Empty className="py-12">
          <EmptyHeader className="mb-0 items-center">
            <div className="mb-3 flex items-center gap-3 text-tertiary">
              <Hash01 aria-hidden="true" className="size-7" />
              <MessageChatCircle aria-hidden="true" className="size-7" />
            </div>
            <EmptyTitle>{m.agent_chat_empty_title()}</EmptyTitle>
            <EmptyDescription className="max-w-72">
              {m.agent_chat_empty_description()}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <section className="border-b border-secondary">
            <SectionHeader
              caption={m.agent_chat_channels_caption()}
              hint={m.agent_chat_channels_hint()}
            />
            {channels.length > 0 ? (
              <div className="px-4 pb-4">
                <AgentChannelList channels={channels} />
              </div>
            ) : (
              <SectionEmpty
                icon={Hash01}
                title={m.agent_chat_channels_empty_title()}
                description={m.agent_chat_channels_empty_description()}
              />
            )}
          </section>
          <section>
            <SectionHeader
              caption={m.agent_profile_section_peer_dms()}
              hint={m.agent_chat_dms_hint()}
            />
            {peers.length > 0 ? (
              <div className="px-4 pb-4">
                <AgentPeerDmList cards={peers} timeZone={timeZone} />
              </div>
            ) : (
              <SectionEmpty
                icon={MessageChatCircle}
                title={m.agent_chat_dms_empty_title()}
                description={m.agent_chat_dms_empty_description()}
              />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function SectionHeader({ caption, hint }: { caption: string; hint: string }) {
  return (
    <div className="px-5 py-3">
      <p className={SECTION_CAPTION_CLASS}>{caption}</p>
      <p className="mt-1 text-xs text-tertiary">{hint}</p>
    </div>
  );
}

/** One section with nothing in it yet, while the other has rows. */
function SectionEmpty({
  icon: Icon,
  title,
  description,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: "true" }>;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3 px-5 pb-4">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-secondary text-tertiary">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-secondary">{title}</p>
        <p className="text-xs text-tertiary">{description}</p>
      </div>
    </div>
  );
}
