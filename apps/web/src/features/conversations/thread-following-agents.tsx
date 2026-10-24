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
} from "./channels.functions";
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
}: {
  agent: FollowingAgent;
  canUnfollow: boolean;
  onOpenProfile?: (agentId: string) => void;
  onUnfollow: (agentId: string) => void;
}) {
  useWatchAgentDisplay(agent.id);
  const live = useLiveAgent(agent.id);
  return (
    <AgentListRow
      agentId={agent.id}
      name={agent.displayName}
      src={agent.avatarUrl}
      display={live?.display}
      onOpenProfile={onOpenProfile ? () => onOpenProfile(agent.id) : undefined}
      action={
        canUnfollow && (
          <ButtonUtility
            icon={XClose}
            size="sm"
            color="tertiary"
            tooltip={m.conversation_thread_unfollow_agent({ name: agent.displayName })}
            onClick={() => onUnfollow(agent.id)}
          />
        )
      }
    />
  );
}

/**
 * Channel thread header control: the first three following Agents' avatars plus a count,
 * opening the Agents currently following this Thread. Hidden until someone follows. A channel
 * member can stop one Agent following; the Agent stays in the channel.
 */
export function ThreadFollowingAgents({
  channelId,
  threadRootId,
  onOpenAgentProfile,
}: {
  channelId: string;
  threadRootId: string;
  onOpenAgentProfile?: (agentId: string) => void;
}) {
  const toast = useAppToast();
  const queryClient = useQueryClient();
  const unfollow = useServerFn(unfollowPublicChannelThreadAgent);
  const query = useThreadFollowingAgents(channelId, threadRootId);
  const queryKey = threadFollowingAgentsQueryKey(channelId, threadRootId);
  const agents = query.data?.agents ?? [];
  const canUnfollow = query.data?.canUnfollow ?? false;
  const count = agents.length;

  async function unfollowAgent(agentId: string) {
    try {
      await unfollow({ data: { channelId, threadRootId, agentId } });
      queryClient.setQueryData(queryKey, (current: typeof query.data) =>
        current
          ? { ...current, agents: current.agents.filter((agent) => agent.id !== agentId) }
          : current,
      );
    } catch {
      toast.error(m.conversation_thread_following_agents_unfollow_error());
    }
  }

  // Only a load with nothing to show is a failure: a failed background refetch keeps the list
  // it already has.
  const failed = query.isError && !query.data;
  // Shown once someone follows; a failure still gets a trigger, so its message can be read.
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
        // Base Button wraps children in an inline `span[data-text]`; make it the flex row that
        // holds the avatar stack and the count.
        className="px-1.5 [&>[data-text]]:flex [&>[data-text]]:items-center [&>[data-text]]:gap-1.5"
      >
        {failed ? (
          <AlertCircle aria-hidden="true" className="size-4 text-fg-quaternary" />
        ) : (
          <>
            <span aria-hidden="true" className="flex -space-x-1">
              {agents.slice(0, 3).map((agent) => (
                // The popover's rows carry each Agent's status.
                <AgentStackFace key={agent.id} agent={agent} />
              ))}
            </span>
            <span aria-hidden="true" className="tabular-nums">
              {count}
            </span>
          </>
        )}
      </Button>
      <AgentListPopover label={m.conversation_thread_following_agents()}>
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
                    onUnfollow={(agentId) => void unfollowAgent(agentId)}
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
