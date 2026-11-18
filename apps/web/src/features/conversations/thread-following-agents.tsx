import { useRef } from "react";
import { DialogTrigger as AriaDialogTrigger, Heading } from "react-aria-components";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertCircle, XClose } from "@untitledui/icons";

import { Button } from "#src/components/base/buttons/button";
import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { useAppToast } from "#src/components/ui/toast";
import { AgentStackFace } from "#src/features/agents/agent-display-avatar";
import {
  AgentListPopover,
  AgentListRow,
  AgentListRows,
} from "#src/features/agents/agent-list-popover";
import { useLiveAgent } from "#src/features/agents/workspace-agents-realtime";
import { useWatchAgentDisplay } from "#src/features/agents/watched-agent-displays";
import { m } from "#src/paraglide/messages";
import {
  loadPublicChannelThreadFollowingAgents,
  unfollowPublicChannelThreadAgent,
} from "./channel-threads.functions";
import { threadFollowingAgentsQueryKey } from "./conversation-query-keys";

type FollowingAgent = {
  id: string;
  name: string;
  displayName: string;
  avatarUrl?: string | null;
};

function useThreadFollowingAgents(channelId: string, threadRootId: string) {
  const load = useServerFn(loadPublicChannelThreadFollowingAgents);
  return useQuery({
    queryKey: threadFollowingAgentsQueryKey(channelId, threadRootId),
    queryFn: () => load({ data: { channelId, threadRootId } }),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

function FollowingAgentRow({
  agent,
  canUnfollow,
  onOpenProfile,
  onUnfollow,
  listFocus,
}: {
  agent: FollowingAgent;
  canUnfollow: boolean;
  onOpenProfile?: (agentId: string) => void;
  onUnfollow: (agentId: string) => Promise<void>;
  listFocus: () => HTMLElement | null;
}) {
  const toast = useAppToast();
  useWatchAgentDisplay(agent.id);
  const live = useLiveAgent(agent.id);
  return (
    <AgentListRow
      agentId={agent.id}
      name={agent.displayName}
      src={agent.avatarUrl}
      mascot={live?.mascot}
      display={live?.display}
      onOpenProfile={onOpenProfile ? () => onOpenProfile(agent.id) : undefined}
      action={
        canUnfollow && (
          <ButtonUtility
            icon={XClose}
            size="sm"
            color="tertiary"
            tooltip={m.conversation_thread_unfollow_agent({ name: agent.displayName })}
            onClick={() =>
              void onUnfollow(agent.id).then(
                () => listFocus()?.focus(),
                () => toast.error(m.conversation_thread_following_agents_unfollow_error()),
              )
            }
          />
        )
      }
    />
  );
}

export function ThreadFollowingAgents({
  channelId,
  threadRootId,
  onOpenAgentProfile,
}: {
  channelId: string;
  threadRootId: string;
  onOpenAgentProfile?: (agentId: string) => void;
}) {
  const queryClient = useQueryClient();
  const unfollow = useServerFn(unfollowPublicChannelThreadAgent);
  const query = useThreadFollowingAgents(channelId, threadRootId);
  const queryKey = threadFollowingAgentsQueryKey(channelId, threadRootId);
  const listDialogRef = useRef<HTMLElement>(null);
  const agents = query.data?.agents ?? [];
  const canUnfollow = query.data?.canUnfollow ?? false;
  const count = agents.length;

  async function unfollowAgent(agentId: string) {
    await unfollow({ data: { channelId, threadRootId, agentId } });
    queryClient.setQueryData(queryKey, (current: typeof query.data) =>
      current
        ? { ...current, agents: current.agents.filter((agent) => agent.id !== agentId) }
        : current,
    );
  }

  const failed = query.isError && !query.data;
  if (!failed && count === 0) return null;

  return (
    <AriaDialogTrigger>
      <Button
        color="tertiary"
        size="sm"
        aria-label={
          failed
            ? m.conversation_thread_following_agents_error()
            : m.conversation_thread_following_agents_count({ count })
        }
        className="px-1.5 [&>[data-text]]:flex [&>[data-text]]:items-center [&>[data-text]]:gap-1.5"
      >
        {failed ? (
          <AlertCircle aria-hidden="true" className="size-4 text-fg-quaternary" />
        ) : (
          <>
            <span aria-hidden="true" className="flex -space-x-1">
              {agents.slice(0, 3).map((agent) => (
                <AgentStackFace key={agent.id} agent={agent} />
              ))}
            </span>
            <span aria-hidden="true" className="tabular-nums">
              {count}
            </span>
          </>
        )}
      </Button>
      <AgentListPopover label={m.conversation_thread_following_agents()} dialogRef={listDialogRef}>
        {(close) => (
          <>
            <div className="border-b border-secondary px-3 py-2">
              <Heading slot="title" className="text-sm font-semibold text-primary">
                {m.conversation_thread_following_agents()}
              </Heading>
            </div>
            {failed ? (
              <p role="alert" className="px-3 py-3 text-sm text-error-primary">
                {m.conversation_thread_following_agents_error()}
              </p>
            ) : (
              <AgentListRows>
                {agents.map((agent) => (
                  <FollowingAgentRow
                    key={agent.id}
                    agent={agent}
                    canUnfollow={canUnfollow}
                    onOpenProfile={
                      onOpenAgentProfile
                        ? (agentId) => {
                            close();
                            onOpenAgentProfile(agentId);
                          }
                        : undefined
                    }
                    onUnfollow={unfollowAgent}
                    listFocus={() => listDialogRef.current}
                  />
                ))}
              </AgentListRows>
            )}
          </>
        )}
      </AgentListPopover>
    </AriaDialogTrigger>
  );
}
