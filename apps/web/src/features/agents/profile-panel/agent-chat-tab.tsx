import { useQuery } from "@tanstack/react-query";
import { CircleAlert, MessageSquare } from "kubai-icons/duotone";

import { EmptyState, RetryButton } from "#src/components/ui/empty";
import { EmptyIcon } from "#src/components/ui/empty-icon";
import { Skeleton } from "#src/components/ui/skeleton";
import { cn } from "#src/lib/utils";
import { m } from "#src/paraglide/messages";
import { AgentChannelList } from "./agent-chat-channels";
import { AgentPeerDmList } from "./agent-peer-dms-section";
import { agentChannelsQuery, agentPeerConversationsQuery } from "./agent-profile-queries";
import { SECTION_CAPTION_CLASS } from "./inline-edit-field";
import { AGENT_TAB_BAR_CLASS, AgentTabEmpty } from "./agent-tab-empty";

export function AgentChatTab({ agentId, timeZone }: { agentId: string; timeZone: string | null }) {
  const channelsQuery = useQuery(agentChannelsQuery(agentId));
  const peersQuery = useQuery(agentPeerConversationsQuery(agentId));
  const channels = channelsQuery.data;
  const peers = peersQuery.data;

  return (
    <div>
      <h2 className={cn(AGENT_TAB_BAR_CLASS, "px-5 text-xs font-medium text-secondary")}>
        {m.agent_chat_heading()}
      </h2>
      {channelsQuery.isError || peersQuery.isError ? (
        <div className="p-5">
          <EmptyState
            size="card"
            role="alert"
            picture={<EmptyIcon icon={CircleAlert} size="card" />}
            title={m.agent_chat_error()}
            primaryAction={
              <RetryButton
                size="card"
                isRetrying={channelsQuery.isRefetching || peersQuery.isRefetching}
                onPress={() => {
                  void channelsQuery.refetch();
                  void peersQuery.refetch();
                }}
              />
            }
          />
        </div>
      ) : !channels || !peers ? (
        <div className="space-y-3 p-5" aria-busy="true" aria-label={m.agent_chat_loading()}>
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-5/6 rounded-lg" />
        </div>
      ) : channels.length === 0 && peers.length === 0 ? (
        <AgentTabEmpty
          belowBar
          level={3}
          picture={<EmptyIcon icon={MessageSquare} />}
          title={m.agent_chat_empty_title()}
          description={m.agent_chat_empty_description()}
        />
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
              <div className="px-5 pb-4">
                <EmptyState
                  size="card"
                  picture={<EmptyIcon icon={MessageSquare} size="card" muted />}
                  title={m.agent_chat_channels_empty_title()}
                />
              </div>
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
              <div className="px-5 pb-4">
                <EmptyState
                  size="card"
                  picture={<EmptyIcon icon={MessageSquare} size="card" muted />}
                  title={m.agent_chat_dms_empty_title()}
                />
              </div>
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
