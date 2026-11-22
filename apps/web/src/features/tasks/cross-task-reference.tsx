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
import type { DirectPeer } from "#src/features/conversations/sidebar-rows";
import { humanLabel } from "#src/lib/human-label";
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
  children: ReactNode;
  onOpenTask?: (number: number) => void;
  prose?: boolean;
};

export function CrossTaskReference(props: CrossTaskReferenceProps) {
  const openConversationId = useConversationId();
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

export function directPeerLabel(
  peer: DirectPeer | undefined,
  agentName: string | undefined,
): string | undefined {
  if (!peer) return undefined;
  if (peer.kind === "people") return humanLabel(peer);
  return agentName ? `@${agentName}` : undefined;
}

function DirectTaskReference({ conversationId, number, children, prose }: CrossTaskReferenceProps) {
  const workspaceId = useCurrentWorkspaceId() ?? "";
  const peer = useDirectPeerLabel(conversationId);
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

function useDirectPeerLabel(conversationId: string): string | undefined {
  const peer = useLiveDirectRow(conversationId)?.peer;
  const agent = useLiveAgent(peer?.kind === "agent" ? peer.agentId : "");
  return directPeerLabel(peer, agent?.name);
}
