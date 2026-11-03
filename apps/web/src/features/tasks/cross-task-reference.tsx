import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import {
  useCurrentWorkspaceId,
  useLiveAgent,
} from "#src/features/agents/workspace-agents-realtime";
import { useConversationId } from "#src/features/conversations/conversation-id";
import { conversationRoute } from "#src/features/conversations/last-conversation";
import { useLiveDirectRow } from "#src/features/conversations/sidebar-lists";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { m } from "#src/paraglide/messages";
import { directTaskQuery } from "./referenced-task";
import { HiddenTaskChip, TaskChip } from "./task-chip";
import { TaskReference } from "./task-reference";
import { overviewTaskQuery } from "./use-finished-tasks";

type CrossTaskReferenceProps = {
  conversationId: string;
  number: number;
  kind: "channel" | "dm";
  /** The reference as the sender wrote it (`#design:#7`, `dm:@ada:#7`): what a reader who cannot
   * see the Task reads. */
  children: ReactNode;
  /** Opens a Task of the open conversation, for a reference that names it. */
  onOpenTask?: (number: number) => void;
};

/**
 * Another conversation's Task in a message body (task #437): the Task's badge under its
 * conversation's current name, its title as the tooltip, a link that opens it there. A reader who
 * cannot see that Task — a private channel they are not in, a direct message of others' — reads
 * the words the sender wrote, with no title or status and nothing to open.
 */
export function CrossTaskReference(props: CrossTaskReferenceProps) {
  const openConversationId = useConversationId();
  // Outside a conversation (a forwarded card, itself one link) a reference is its words; one that
  // names the open conversation is its own Task's badge.
  if (!openConversationId) return <>{props.children}</>;
  if (props.conversationId === openConversationId)
    return (
      <TaskReference number={props.number} onOpenTask={props.onOpenTask}>
        {props.children}
      </TaskReference>
    );
  return props.kind === "channel" ? (
    <ChannelTaskReference {...props} />
  ) : (
    <DirectTaskReference {...props} />
  );
}

function ChannelTaskReference({ conversationId, number, children }: CrossTaskReferenceProps) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const { data: task } = useQuery(overviewTaskQuery(workspaceId, { conversationId, number }));
  const open = useOpenTask("channel", conversationId, number);
  if (task === undefined) return <>{children}</>;
  if (task === null || task.source.channelName === null) return <HiddenTaskChip />;
  return <TaskChip task={task} place={`#${task.source.channelName}`} onPress={open} />;
}

function DirectTaskReference({ conversationId, number, children }: CrossTaskReferenceProps) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const peer = useDirectPeerHandle(conversationId);
  // A direct message the viewer is not in has no Task of theirs to read.
  const { data: task, isPending } = useQuery({
    ...directTaskQuery(workspaceId, { conversationId, number }),
    enabled: peer !== undefined,
  });
  const open = useOpenTask("dm", conversationId, number);
  if (peer !== undefined && isPending) return <>{children}</>;
  if (!task || !peer) return <HiddenTaskChip />;
  return <TaskChip task={task} place={m.tasks_ref_dm({ peer })} onPress={open} />;
}

/** Who a direct message is with, from the viewer's seat: the other side's handle, or undefined
 * when the viewer is not in it. */
function useDirectPeerHandle(conversationId: string): string | undefined {
  const peer = useLiveDirectRow(conversationId)?.peer;
  const agent = useLiveAgent(peer?.kind === "agent" ? peer.agentId : "");
  if (!peer) return undefined;
  return peer.kind === "people" ? peer.username : agent?.name;
}

/** Opens another conversation's Task there. */
function useOpenTask(kind: "channel" | "dm", conversationId: string, number: number) {
  const workspaceSlug = useWorkspaceSlug();
  const navigate = useNavigate();
  return () =>
    void navigate({
      ...conversationRoute(
        kind === "channel" ? { channelId: conversationId } : { dmId: conversationId },
        workspaceSlug,
      ),
      search: { task: number },
    });
}
