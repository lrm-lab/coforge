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
import { readMessageReferences } from "#src/lib/message-references";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import {
  channelThreadRootsWhere,
  messageIdMatchesAnchor,
} from "#src/server/db/message-anchor.server";

/**
 * How many distinct thread references one body resolves, in reading order; any after them stay as
 * written. Mentions, tasks and channels each resolve in one query however many a body holds;
 * thread references read their channels' messages, so their number is bounded to keep that read
 * small inside the send transaction.
 */
export const MAX_THREAD_REFERENCES = 20;

/**
 * A channel's mention targets for `storeMessageBody`: only its active members the given handles
 * name (`user.username` or `agent.name`), so a send never reads the roster of #general, which
 * holds the whole Workspace. Handles resolve to ids through their unique indexes first, so the
 * member read is by id too, not a join tested against every member of the channel.
 */
export async function channelMentionTargets(
  tx: Pick<Prisma.TransactionClient, "conversationMember" | "user" | "agent">,
  scope: { workspaceId: string; conversationId: string },
  handles: readonly string[],
): Promise<MentionTarget[]> {
  const [users, agents] = await Promise.all([
    tx.user.findMany({
      where: { username: { in: [...handles] } },
      select: { id: true, username: true },
    }),
    tx.agent.findMany({
      where: { workspaceId: scope.workspaceId, name: { in: [...handles] } },
      select: { id: true, name: true },
    }),
  ]);
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

/**
 * The body a send stores, and the mentions it resolved: every reference the server can resolve
 * becomes its structured token, so no reader ever has to parse prose again. The body is read once
 * (`readMessageReferences`) and its candidates answered here:
 *
 * - `@handle` names one of the conversation's mention `targets` (a DM passes none, so its
 *   `@handle` stays text), with `bindings` — the CLI's `--mention` selectors — first. `targets`
 *   may instead load only the members the body's `@handle` candidates and the bindings' names
 *   name (`channelMentionTargets`), so a large channel's roster is never read to resolve a
 *   message that mentions a few members, or none;
 * - `task #N`, or a bare `#N`, names a task of this conversation;
 * - `#name` names a channel of this Workspace the sender (`scope.reader`) may read
 *   (`visibleChannelWhere`, archived ones included): a private channel it is not in stays text, so
 *   a reference reveals no private channel and no message of one. A bare `#N` names one only when
 *   no task has that number (see `readMessageReferences` for the full precedence);
 * - `#name:shortid` names a top-level message of that channel, by a 6–8 hex prefix only that
 *   message's id has, or by its whole id (`channelThreadRootsWhere`, the rule an Agent's thread
 *   target is found by). Only the first `MAX_THREAD_REFERENCES` distinct ones are looked up, in one
 *   read per channel.
 *
 * Anything unresolved stays byte-for-byte as written, a token the sender typed included. A token is
 * a claim, never trusted as stored: every consumer checks it against authoritative data (a mention
 * token against the message's mention rows, a channel or thread token against the Workspace's
 * channels, a task token against the conversation's tasks), so a typed token does nothing that typing the
 * text could not.
 */
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
): Promise<{ body: string; mentions: ResolvedMention[] }> {
  const references = readMessageReferences(body);
  const { handles } = references.candidates;
  const threads = references.candidates.threads.slice(0, MAX_THREAD_REFERENCES);
  // A thread reference's channel is looked up with the channels, in the same query.
  const channelTasks = references.candidates.channelTasks;
  const dmTasks = references.candidates.dmTasks;
  const channelNames = [
    ...new Set([
      ...references.candidates.channelNames,
      ...threads.map((thread) => thread.name),
      ...channelTasks.map((task) => task.name),
    ]),
  ];
  // A `#N` above the largest task number names no task, and is never sent to the query, which
  // would reject it.
  const taskNumbers = references.candidates.taskNumbers.filter(
    (number) => number <= PG_INTEGER_MAX,
  );
  // A binding need not appear in the body, so the loader is asked for its name as well.
  const targetHandles = [
    ...new Set([...handles, ...(mentionScope.bindings ?? []).map((binding) => binding.name)]),
  ];
  const targets =
    typeof mentionScope.targets === "function"
      ? targetHandles.length
        ? await mentionScope.targets(targetHandles)
        : []
      : mentionScope.targets;
  const mentions = resolveMentionTargets(handles, targets, mentionScope.bindings);
  const knownTasks = new Set(
    taskNumbers.length
      ? (
          await tx.task.findMany({
            where: {
              conversationId: scope.conversationId,
              number: { in: taskNumbers },
              ...LIVE_TASK_WHERE,
            },
            select: { number: true },
          })
        ).map((task) => task.number)
      : [],
  );
  const channelsByName = new Map(
    channelNames.length
      ? (
          await tx.conversation.findMany({
            // A channel hidden from the Workspace names nothing: `#general` stays plain text.
            where: {
              ...visibleChannelWhere(scope.workspaceId, scope.reader),
              channelName: { in: channelNames },
            },
            select: { id: true, channelName: true },
          })
        ).map((channel) => [channel.channelName!, { id: channel.id, name: channel.channelName! }])
      : [],
  );
  // One read per channel over its top-level messages, for every anchor into it; an anchor two rows
  // answer is ambiguous, and names nothing.
  const anchorsByChannel = new Map<string, string[]>();
  for (const { name, anchor } of threads) {
    if (!channelsByName.has(name)) continue;
    anchorsByChannel.set(name, [...(anchorsByChannel.get(name) ?? []), anchor]);
  }
  const threadRoots = new Map<string, string>();
  for (const [name, anchors] of anchorsByChannel) {
    const rows = await tx.message.findMany({
      where: channelThreadRootsWhere(channelsByName.get(name)!.id, anchors),
      select: { id: true },
    });
    for (const anchor of anchors) {
      const matches = rows.filter((row) => messageIdMatchesAnchor(row.id, anchor));
      if (matches.length === 1) threadRoots.set(`${name}:${anchor}`, matches[0]!.id);
    }
  }
  // Another conversation's task is a v2 write: v1 only reads the tokens, so nothing is written
  // until the flag is switched on after a release that can render them.
  const crossTaskReferences =
    (channelTasks.length > 0 || dmTasks.length > 0) &&
    (options.crossTaskReferences ??
      (await isFeatureEnabled("task-ref-tokens", { workspaceId: scope.workspaceId })));
  const channelTaskByRef = new Map<string, { conversationId: string; channelName: string }>();
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
        number: true,
        conversationId: true,
        conversation: { select: { channelName: true } },
      },
    });
    for (const row of rows)
      channelTaskByRef.set(`${row.conversation.channelName}:${row.number}`, {
        conversationId: row.conversationId,
        channelName: row.conversation.channelName!,
      });
  }
  const dmTaskByRef = new Map<string, { conversationId: string; peerHandle: string }>();
  if (crossTaskReferences && dmTasks.length) {
    // Raft's rule: a bare handle that both a person and an Agent answer is ambiguous and stays
    // text; a `~human`/`~agent` suffix picks the kind.
    const nameOf = (peer: string) => peer.replace(/~(?:agent|human)$/i, "");
    const kindOf = (peer: string) =>
      /~agent$/i.test(peer) ? "agent" : /~human$/i.test(peer) ? "user" : null;
    const names = [...new Set(dmTasks.map((task) => nameOf(task.peer)))];
    const [users, agents] = await Promise.all([
      tx.user.findMany({
        where: { username: { in: names } },
        select: { id: true, username: true },
      }),
      tx.agent.findMany({
        where: { workspaceId: scope.workspaceId, name: { in: names } },
        select: { id: true, name: true },
      }),
    ]);
    const userByName = new Map(users.map((user) => [user.username, user.id]));
    const agentByName = new Map(agents.map((agent) => [agent.name, agent.id]));
    const senderWhere =
      "userId" in scope.reader
        ? { userId: scope.reader.userId }
        : { agentId: scope.reader.agentId };
    const direct = await tx.conversation.findMany({
      where: {
        workspaceId: scope.workspaceId,
        channelName: null,
        directKey: { not: null },
        members: { some: senderWhere },
      },
      select: { id: true, members: { select: { userId: true, agentId: true } } },
    });
    const numbers = [...new Set(dmTasks.map((task) => task.number))].filter(
      (number) => number <= PG_INTEGER_MAX,
    );
    const tasks = numbers.length
      ? await tx.task.findMany({
          where: {
            number: { in: numbers },
            conversationId: { in: direct.map((conversation) => conversation.id) },
            ...LIVE_TASK_WHERE,
          },
          select: { number: true, conversationId: true },
        })
      : [];
    for (const task of dmTasks) {
      const name = nameOf(task.peer);
      const kind = kindOf(task.peer);
      const peerIds = [
        ...(kind !== "agent" && userByName.has(name) ? [userByName.get(name)!] : []),
        ...(kind !== "user" && agentByName.has(name) ? [agentByName.get(name)!] : []),
      ];
      // One conversation of the sender's with exactly this peer; two ids (a person and an Agent
      // sharing the name) is ambiguous, and picks neither.
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
      if (!tasks.some((row) => row.conversationId === matches[0]!.id && row.number === task.number))
        continue;
      dmTaskByRef.set(`${task.peer}:${task.number}`, {
        conversationId: matches[0]!.id,
        peerHandle: task.peer,
      });
    }
  }
  return {
    body: references.resolve({
      mention: mentions.target,
      task: (number) => knownTasks.has(number),
      channelTask: (name, number) => channelTaskByRef.get(`${name}:${number}`),
      dmTask: (peer, number) => dmTaskByRef.get(`${peer}:${number}`),
      channel: (name) => channelsByName.get(name),
      thread: (name, anchor) => {
        const channel = channelsByName.get(name);
        const rootId = threadRoots.get(`${name}:${anchor}`);
        return channel && rootId
          ? { channelId: channel.id, rootId, name: channel.name }
          : undefined;
      },
    }),
    mentions: mentions.mentions,
  };
}
