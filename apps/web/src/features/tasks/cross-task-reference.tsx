import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import {
  useCurrentWorkspaceId,
  useLiveAgent,
  useLiveAgents,
} from "#src/features/agents/workspace-agents-realtime";
import { useConversationId } from "#src/features/conversations/conversation-id";
import { sidebarDirectsQuery } from "#src/features/conversations/sidebar-collections";
import { useLiveDirectRow } from "#src/features/conversations/sidebar-lists";
import { m } from "#src/paraglide/messages";
import { useOpenOtherTask } from "./other-task-search";
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
  /** Parsed back out of the written `#channel:#N` / `dm:@peer:#N` form rather than a stored
   * token: the sender may never have been able to resolve it, so a reader who cannot sees the
   * words, never the locked chip a stored token's reader gets. */
  prose?: boolean;
};

/**
 * Another conversation's Task in a message body (task #437): the Task's badge under its
 * conversation's current name, its title as the tooltip, a press that opens its popup over the
 * page. A reader who cannot see that Task — a private channel they are not in, a direct message of
 * others' — reads the locked chip when the sender's stored token asserts one may be there, or the
 * sender's written words when the body only holds the typed form; either way no title, status or
 * press.
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

/** What an unresolved cross-conversation reference shows: a stored token's reader who cannot
 * see the Task gets the locked chip (the sender could, so a Task may really be there); a
 * written reference's reader gets the sender's words back — nothing proves a Task exists. */
export function UnresolvedTaskReference({
  prose,
  children,
}: {
  prose?: boolean;
  children: ReactNode;
}) {
  return prose ? <>{children}</> : <HiddenTaskChip />;
}

function ChannelTaskReference({
  conversationId,
  number,
  children,
  prose,
}: CrossTaskReferenceProps) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const { data: task } = useQuery(overviewTaskQuery(workspaceId, { conversationId, number }));
  const { open } = useOpenOtherTask();
  if (task === undefined) return <>{children}</>;
  if (task === null || task.source.channelName === null)
    return <UnresolvedTaskReference prose={prose}>{children}</UnresolvedTaskReference>;
  return (
    <TaskChip
      task={task}
      channel={task.source.channelName}
      onPress={() => open({ kind: "channel", conversationId, number })}
    />
  );
}

function DirectTaskReference({ conversationId, number, children, prose }: CrossTaskReferenceProps) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const peer = useDirectPeerHandle(conversationId);
  // A direct message the viewer is not in has no Task of theirs to read.
  const { data: task, isPending } = useQuery({
    ...directTaskQuery(workspaceId, { conversationId, number }),
    enabled: peer !== undefined,
  });
  const { open } = useOpenOtherTask();
  if (peer !== undefined && isPending) return <>{children}</>;
  if (!task || !peer)
    return <UnresolvedTaskReference prose={prose}>{children}</UnresolvedTaskReference>;
  return (
    <TaskChip
      task={task}
      place={m.tasks_ref_dm({ peer })}
      onPress={() => open({ kind: "dm", conversationId, number })}
    />
  );
}

/**
 * A direct message's Task as written, `dm:@peer:#N` (task #472): the viewer's direct message with
 * that peer, then that DM's Task as `CrossTaskReference` draws it. A Raft-style `~agent`/`~human`
 * suffix says which kind of peer it is. A reader with no such direct message (the peer themself,
 * reading the sender's words, or anyone else) reads the words as written.
 */
export function DirectTaskReferenceByPeer({
  peer,
  number,
  children,
  onOpenTask,
}: {
  peer: string;
  number: number;
  children: ReactNode;
  onOpenTask?: (number: number) => void;
}) {
  const conversationId = useDirectConversationWith(peer);
  if (conversationId === undefined) return <>{children}</>;
  return (
    <CrossTaskReference
      conversationId={conversationId}
      number={number}
      kind="dm"
      onOpenTask={onOpenTask}
      prose
    >
      {children}
    </CrossTaskReference>
  );
}

/** The viewer's direct message with the member or Agent `handle` names, from the sidebar's DM list. */
function useDirectConversationWith(handle: string): string | undefined {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const { data: rows } = useQuery({
    ...sidebarDirectsQuery(workspaceId),
    select: (read) => read.rows,
    enabled: workspaceId !== "",
  });
  const agents = useLiveAgents();
  const suffix = /~(agent|human)$/i.exec(handle)?.[1]?.toLowerCase();
  const name = handle.replace(/~(agent|human)$/i, "").toLowerCase();
  const row = rows?.find((each) =>
    each.peer.kind === "people"
      ? suffix !== "agent" && each.peer.username.toLowerCase() === name
      : suffix !== "human" &&
        agents
          .find((agent) => agent.id === (each.peer as { agentId: string }).agentId)
          ?.name.toLowerCase() === name,
  );
  return row?.conversationId;
}

/** Who a direct message is with, from the viewer's seat: the other side's handle, or undefined
 * when the viewer is not in it. */
function useDirectPeerHandle(conversationId: string): string | undefined {
  const peer = useLiveDirectRow(conversationId)?.peer;
  const agent = useLiveAgent(peer?.kind === "agent" ? peer.agentId : "");
  if (!peer) return undefined;
  return peer.kind === "people" ? peer.username : agent?.name;
}
