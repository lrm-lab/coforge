import type { TaskStatus } from "@lrm/coforge-sdk/internal";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Focusable } from "react-aria-components";

import { Tooltip } from "#src/components/base/tooltip/tooltip";
import {
  useCurrentWorkspaceId,
  useLiveAgent,
} from "#src/features/agents/workspace-agents-realtime";
import { useConversationId } from "#src/features/conversations/conversation-id";
import { conversationRoute } from "#src/features/conversations/last-conversation";
import { useLiveDirectRow } from "#src/features/conversations/sidebar-lists";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { cn } from "#src/lib/utils";
import { directTaskQuery } from "./referenced-task";
import { TASK_CHIP_CLASS, TASK_CHIP_CONTROL_CLASS, TaskReference } from "./task-reference";
import { TaskNumberBadge, statusLabel } from "./task-status-icon";
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
  if (!task || task.source.channelName === null) return <>{children}</>;
  return (
    <TaskChip
      kind="channel"
      conversationId={conversationId}
      number={number}
      label={`#${task.source.channelName}:#${number}`}
      title={task.title}
      status={task.status}
    />
  );
}

function DirectTaskReference({ conversationId, number, children }: CrossTaskReferenceProps) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const peer = useDirectPeerHandle(conversationId);
  // A direct message the viewer is not in has no Task of theirs to read.
  const { data: task } = useQuery({
    ...directTaskQuery(workspaceId, { conversationId, number }),
    enabled: peer !== undefined,
  });
  // Unread, the words name the other side from the viewer's seat too, never the viewer themself.
  if (!task || !peer) return <>{peer ? `dm:@${peer}:#${number}` : children}</>;
  return (
    <TaskChip
      kind="dm"
      conversationId={conversationId}
      number={number}
      label={`dm:@${peer}:#${number}`}
      title={task.title}
      status={task.status}
    />
  );
}

/** Who a direct message is with, from the viewer's seat: the other side's handle, or undefined
 * when the viewer is not in it. */
function useDirectPeerHandle(conversationId: string): string | undefined {
  const peer = useLiveDirectRow(conversationId)?.peer;
  const agent = useLiveAgent(peer?.kind === "agent" ? peer.agentId : "");
  if (!peer) return undefined;
  return peer.kind === "people" ? peer.username : agent?.name;
}

function TaskChip({
  kind,
  conversationId,
  number,
  label,
  title,
  status,
}: {
  kind: "channel" | "dm";
  conversationId: string;
  number: number;
  label: string;
  title: string;
  status: TaskStatus;
}) {
  const workspaceSlug = useWorkspaceSlug();
  const route = conversationRoute(
    kind === "channel" ? { channelId: conversationId } : { dmId: conversationId },
    workspaceSlug,
  );
  return (
    <Tooltip title={title}>
      <Focusable>
        <Link
          {...route}
          search={{ task: number }}
          // The ring is decorative, so the status is spelled out in the link's name, with the title.
          aria-label={`${label}, ${title}, ${statusLabel(status)}`}
          data-task-status={status}
          className={cn(TASK_CHIP_CLASS, TASK_CHIP_CONTROL_CLASS)}
        >
          <TaskNumberBadge number={number} status={status} label={label} />
        </Link>
      </Focusable>
    </Tooltip>
  );
}
