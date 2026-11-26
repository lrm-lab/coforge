import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import type { ChannelActor } from "./channel-actor.server";
import { LIVE_TASK_WHERE } from "#src/server/tasks/task-view.server";
import { visibleChannelWhere } from "./channel-read-access.server";
import {
  PG_INTEGER_MAX,
  resolveMentionTargets,
  type MentionSelectorInput,
  type MentionTarget,
  type ResolvedMention,
} from "@lrm/coforge-sdk/internal";
import type { Prisma } from "#src/generated/prisma/client";
import { readMessageReferences } from "@lrm/coforge-sdk/internal/message-references";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import {
  channelThreadRootsWhere,
  messageIdMatchesAnchor,
} from "#src/server/db/message-anchor.server";

export const MAX_THREAD_REFERENCES = 20;

export async function channelMentionTargets(
  tx: Pick<Prisma.TransactionClient, "conversationMember" | "user" | "agent">,
  scope: { workspaceId: string; conversationId: string },
  handles: readonly string[],
): Promise<MentionTarget[]> {
  const users = await tx.user.findMany({
    where: { username: { in: [...handles] } },
    select: { id: true, username: true },
  });
  const agents = await tx.agent.findMany({
    where: { workspaceId: scope.workspaceId, name: { in: [...handles] } },
    select: { id: true, name: true },
  });
  if (!users.length && !agents.length) return [];
  const usernames = new Map(users.map((user) => [user.id, user.username]));
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const members = await tx.conversationMember.findMany({
    where: {
      conversationId: scope.conversationId,
      ...ACTIVE_MEMBER_WHERE,
      OR: [{ userId: { in: [...usernames.keys()] } }, { agentId: { in: [...agentNames.keys()] } }],
    },
    select: { id: true, userId: true, agentId: true },
  });
  return members.map((member) =>
    member.userId
      ? { key: member.id, type: "user", id: member.userId, handle: usernames.get(member.userId)! }
      : {
          key: member.id,
          type: "agent",
          id: member.agentId!,
          handle: agentNames.get(member.agentId!)!,
        },
  );
}

export async function storeMessageBody(
  tx: Pick<
    Prisma.TransactionClient,
    "task" | "conversation" | "message" | "conversationMember" | "user" | "agent"
  >,
  scope: { workspaceId: string; conversationId: string; reader: ChannelActor },
  body: string,
  mentionScope: {
    targets:
      | readonly MentionTarget[]
      | ((handles: readonly string[]) => Promise<readonly MentionTarget[]>);
    bindings?: readonly MentionSelectorInput[];
  },
  options: { crossTaskReferences?: boolean } = {},
): Promise<{
  body: string;
  mentions: ResolvedMention[];
  references: { kind: string; targetId: string; raw: string; ordinal: number }[];
}> {
  const references = readMessageReferences(body);
  const { handles } = references.candidates;
  const threads = references.candidates.threads.slice(0, MAX_THREAD_REFERENCES);
  const channelTasks = references.candidates.channelTasks;
  const dmTasks = references.candidates.dmTasks;
  const channelNames = [
    ...new Set([
      ...references.candidates.channelNames,
      ...threads.map((thread) => thread.name),
      ...channelTasks.map((task) => task.name),
    ]),
  ];
  const taskNumbers = references.candidates.taskNumbers.filter(
    (number) => number <= PG_INTEGER_MAX,
  );
  const targetHandles = [
    ...new Set([...handles, ...(mentionScope.bindings ?? []).map((binding) => binding.name)]),
  ];
  const needsCrossTaskCheck = channelTasks.length > 0 || dmTasks.length > 0;
  const crossTaskFlagPromise = needsCrossTaskCheck
    ? options.crossTaskReferences !== undefined
      ? Promise.resolve(options.crossTaskReferences)
      : isFeatureEnabled("task-ref-tokens", { workspaceId: scope.workspaceId })
    : Promise.resolve(false);
  const targets =
    typeof mentionScope.targets === "function"
      ? targetHandles.length
        ? await mentionScope.targets(targetHandles)
        : []
      : mentionScope.targets;
  const mentions = resolveMentionTargets(handles, targets, mentionScope.bindings);
  const taskRows = taskNumbers.length
    ? await tx.task.findMany({
        where: {
          conversationId: scope.conversationId,
          number: { in: taskNumbers },
          ...LIVE_TASK_WHERE,
        },
        select: { id: true, number: true },
      })
    : [];
  const knownTasks = new Map(taskRows.map((task) => [task.number, task.id]));
  const channelRows = channelNames.length
    ? await tx.conversation.findMany({
        where: {
          ...visibleChannelWhere(scope.workspaceId, scope.reader),
          channelName: { in: channelNames },
        },
        select: { id: true, channelName: true },
      })
    : [];
  const channelsByName = new Map(
    channelRows.map((channel) => [
      channel.channelName!,
      { id: channel.id, name: channel.channelName! },
    ]),
  );
  const anchorsByChannel = new Map<string, string[]>();
  for (const { name, anchor } of threads) {
    if (!channelsByName.has(name)) continue;
    anchorsByChannel.set(name, [...(anchorsByChannel.get(name) ?? []), anchor]);
  }
  const threadRoots = new Map<string, string>();
  if (anchorsByChannel.size > 0) {
    const channelEntries = [...anchorsByChannel.entries()].map(([name, anchors]) => ({
      name,
      channelId: channelsByName.get(name)!.id,
      anchors,
    }));
    const anchorRows = await tx.message.findMany({
      where:
        channelEntries.length === 1
          ? channelThreadRootsWhere(channelEntries[0]!.channelId, channelEntries[0]!.anchors)
          : {
              OR: channelEntries.map((entry) =>
                channelThreadRootsWhere(entry.channelId, entry.anchors),
              ),
            },
      select: { id: true, conversationId: true },
    });
    const rowsByChannelId = new Map<string, string[]>();
    for (const row of anchorRows) {
      const list = rowsByChannelId.get(row.conversationId);
      if (list) list.push(row.id);
      else rowsByChannelId.set(row.conversationId, [row.id]);
    }
    for (const entry of channelEntries) {
      const ids = rowsByChannelId.get(entry.channelId) ?? [];
      for (const anchor of entry.anchors) {
        const matches = ids.filter((id) => messageIdMatchesAnchor(id, anchor));
        if (matches.length === 1) threadRoots.set(`${entry.name}:${anchor}`, matches[0]!);
      }
    }
  }
  const crossTaskReferences = needsCrossTaskCheck && (await crossTaskFlagPromise);
  const channelTaskByRef = new Map<
    string,
    { conversationId: string; channelName: string; taskId: string }
  >();
  if (crossTaskReferences && channelTasks.length) {
    const numbers = [...new Set(channelTasks.map((task) => task.number))].filter(
      (number) => number <= PG_INTEGER_MAX,
    );
    const rows = await tx.task.findMany({
      where: {
        number: { in: numbers },
        ...LIVE_TASK_WHERE,
        conversation: {
          ...visibleChannelWhere(scope.workspaceId, scope.reader),
          channelName: { in: channelTasks.map((task) => task.name) },
        },
      },
      select: {
        id: true,
        number: true,
        conversationId: true,
        conversation: { select: { channelName: true } },
      },
    });
    for (const row of rows)
      channelTaskByRef.set(`${row.conversation.channelName}:${row.number}`, {
        conversationId: row.conversationId,
        channelName: row.conversation.channelName!,
        taskId: row.id,
      });
  }
  const dmTaskByRef = new Map<
    string,
    { conversationId: string; peerHandle: string; taskId: string }
  >();
  if (crossTaskReferences && dmTasks.length) {
    const nameOf = (peer: string) => peer.replace(/~(?:agent|human)$/i, "");
    const kindOf = (peer: string) =>
      /~agent$/i.test(peer) ? "agent" : /~human$/i.test(peer) ? "user" : null;
    const names = [...new Set(dmTasks.map((task) => nameOf(task.peer)))];
    const senderWhere =
      "userId" in scope.reader
        ? { userId: scope.reader.userId }
        : { agentId: scope.reader.agentId };
    const users = await tx.user.findMany({
      where: { username: { in: names } },
      select: { id: true, username: true },
    });
    const agents = await tx.agent.findMany({
      where: { workspaceId: scope.workspaceId, name: { in: names } },
      select: { id: true, name: true },
    });
    const direct = await tx.conversation.findMany({
      where: {
        workspaceId: scope.workspaceId,
        channelName: null,
        directKey: { not: null },
        members: { some: senderWhere },
      },
      select: { id: true, members: { select: { userId: true, agentId: true } } },
    });
    const userByName = new Map(users.map((user) => [user.username, user.id]));
    const agentByName = new Map(agents.map((agent) => [agent.name, agent.id]));
    const numbers = [...new Set(dmTasks.map((task) => task.number))].filter(
      (number) => number <= PG_INTEGER_MAX,
    );
    const tasks =
      numbers.length && direct.length
        ? await tx.task.findMany({
            where: {
              number: { in: numbers },
              conversationId: { in: direct.map((conversation) => conversation.id) },
              ...LIVE_TASK_WHERE,
            },
            select: { id: true, number: true, conversationId: true },
          })
        : [];
    for (const task of dmTasks) {
      const name = nameOf(task.peer);
      const kind = kindOf(task.peer);
      const peerIds = [
        ...(kind !== "agent" && userByName.has(name) ? [userByName.get(name)!] : []),
        ...(kind !== "user" && agentByName.has(name) ? [agentByName.get(name)!] : []),
      ];
      if (peerIds.length !== 1) continue;
      const peerId = peerIds[0]!;
      const matches = direct.filter((conversation) => {
        const others = conversation.members.filter(
          (member) =>
            !("userId" in scope.reader
              ? member.userId === scope.reader.userId
              : member.agentId === scope.reader.agentId),
        );
        return (
          others.length === 1 && (others[0]!.userId === peerId || others[0]!.agentId === peerId)
        );
      });
      if (matches.length !== 1) continue;
      const found = tasks.find(
        (row) => row.conversationId === matches[0]!.id && row.number === task.number,
      );
      if (!found) continue;
      dmTaskByRef.set(`${task.peer}:${task.number}`, {
        conversationId: matches[0]!.id,
        peerHandle: task.peer,
        taskId: found.id,
      });
    }
  }
  const stored = references.resolve({
    mention: mentions.target,
    task: (number) => knownTasks.get(number),
    channelTask: (name, number) => channelTaskByRef.get(`${name}:${number}`),
    dmTask: (peer, number) => dmTaskByRef.get(`${peer}:${number}`),
    channel: (name) => channelsByName.get(name),
    thread: (name, anchor) => {
      const channel = channelsByName.get(name);
      const rootId = threadRoots.get(`${name}:${anchor}`);
      return channel && rootId ? { channelId: channel.id, rootId, name: channel.name } : undefined;
    },
  });
  return {
    body: stored.body,
    mentions: mentions.mentions,
    references: stored.adopted
      .filter(
        (
          reference,
        ): reference is typeof reference & {
          kind: "task" | "channel" | "thread";
        } => reference.kind !== "mention",
      )
      .map((reference, ordinal) => ({
        kind: reference.kind,
        targetId: reference.targetId,
        raw: body.slice(reference.start, reference.end),
        ordinal,
      })),
  };
}

export async function writeMessageReferences(
  tx: Pick<Prisma.TransactionClient, "messageReference">,
  message: { id: string },
  scope: { conversationId: string; workspaceId: string },
  references: readonly { kind: string; targetId: string; raw: string; ordinal: number }[],
) {
  if (!references.length) return;
  await tx.messageReference.createMany({
    data: references.map((reference) => ({
      messageId: message.id,
      conversationId: scope.conversationId,
      workspaceId: scope.workspaceId,
      kind: reference.kind,
      targetId: reference.targetId,
      raw: reference.raw,
      ordinal: reference.ordinal,
    })),
  });
}

export async function replaceMessageReferences(
  tx: Pick<Prisma.TransactionClient, "messageReference">,
  message: { id: string },
  scope: { conversationId: string; workspaceId: string },
  references: readonly { kind: string; targetId: string; raw: string; ordinal: number }[],
) {
  await tx.messageReference.deleteMany({ where: { messageId: message.id } });
  await writeMessageReferences(tx, message, scope, references);
}
