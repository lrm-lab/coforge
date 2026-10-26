import type {
  AttachmentCommentMigrationPlan,
  AttachmentCommentMigrationSnapshot,
} from "./attachment-comment-migration-plan.server";

type Snapshot = AttachmentCommentMigrationSnapshot;
type Member = Snapshot["members"][number];
type OldMessage = Snapshot["messages"][number];
type Entry = { sequence: number; old?: OldMessage };

function sameActor(a: Member, b: Member) {
  return a.userId === b.userId && a.agentId === b.agentId;
}
function oldBoundary(snapshot: Snapshot, member: Member, message: OldMessage, done = false) {
  if (message.threadRootId) {
    const cursor = snapshot.threadReads.find(
      (row) => row.memberId === member.id && row.rootMessageId === message.threadRootId,
    );
    return (done ? cursor?.doneThroughSequence : cursor?.readThroughSequence) ?? 0;
  }
  if (done) return member.doneThroughSequence ?? 0;
  const read = member.agentId ? member.agentReadThroughSequence : member.readThroughSequence;
  return member.userId && member.unreadFromSequence !== null
    ? Math.min(read, member.unreadFromSequence - 1)
    : read;
}
function prefix(entries: Entry[], seen: (entry: Entry) => boolean) {
  let sequence = 0;
  for (const entry of entries) {
    if (!seen(entry)) break;
    sequence = entry.sequence;
  }
  return sequence;
}

/** A later read entry cannot move a cursor across an earlier unread entry. */
export function planCommentMigrationReads(
  snapshot: Snapshot,
  moves: AttachmentCommentMigrationPlan["moves"],
) {
  const threadReadMappings: AttachmentCommentMigrationPlan["threadReadMappings"] = [];
  const assistantReadMappings: AttachmentCommentMigrationPlan["assistantReadMappings"] = [];
  const groups = new Map(
    moves.map((move) => [`${move.conversationId}:${move.threadRootId}`, move]),
  );
  for (const [, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const conversationId = group.conversationId;
    const rootMessageId = group.threadRootId;
    const imported = moves.filter(
      (row) => row.conversationId === conversationId && row.threadRootId === rootMessageId,
    );
    const entries: Entry[] = [
      ...snapshot.sourceReplies.filter(
        (row) => row.conversationId === conversationId && row.threadRootId === rootMessageId,
      ),
      ...imported.map((row) => ({
        sequence: row.sequence,
        old: snapshot.messages.find((message) => message.id === row.messageId)!,
      })),
    ].sort((a, b) => a.sequence - b.sequence);
    const oldConversations = new Set(
      imported.map(
        (row) => snapshot.messages.find((message) => message.id === row.messageId)!.conversationId,
      ),
    );
    for (const member of snapshot.members.filter((row) => row.conversationId === conversationId)) {
      if (snapshot.assistantSessions.some((session) => session.agentId === member.agentId))
        continue;
      const oldMembers = snapshot.members.filter(
        (row) => oldConversations.has(row.conversationId) && sameActor(member, row),
      );
      const current = snapshot.threadReads.find(
        (row) => row.memberId === member.id && row.rootMessageId === rootMessageId,
      );
      if (!oldMembers.length && !current) continue;
      const seen = (entry: Entry, done = false) => {
        if (!entry.old)
          return (
            entry.sequence <=
            ((done ? current?.doneThroughSequence : current?.readThroughSequence) ?? 0)
          );
        const old = oldMembers.find((row) => row.conversationId === entry.old!.conversationId);
        return !!old && entry.old.sequence <= oldBoundary(snapshot, old, entry.old, done);
      };
      const readThroughSequence = prefix(entries, (entry) => seen(entry));
      const hadDone =
        current?.doneThroughSequence != null ||
        oldMembers.some(
          (row) =>
            row.doneThroughSequence !== null ||
            snapshot.threadReads.some(
              (cursor) => cursor.memberId === row.id && cursor.doneThroughSequence !== null,
            ),
        );
      threadReadMappings.push({
        memberId: member.id,
        conversationId,
        rootMessageId,
        readThroughSequence,
        doneThroughSequence: hadDone ? prefix(entries, (entry) => seen(entry, true)) : null,
        reunreadMessages: entries.filter(
          (entry) => entry.sequence > readThroughSequence && seen(entry),
        ).length,
      });
    }
    for (const session of snapshot.assistantSessions) {
      const oldMembers = snapshot.members.filter(
        (row) => oldConversations.has(row.conversationId) && row.agentId === session.agentId,
      );
      const oldCursors = snapshot.assistantCursors.filter(
        (row) => row.sessionId === session.id && oldConversations.has(row.conversationId),
      );
      const current = snapshot.assistantCursors.find(
        (row) =>
          row.sessionId === session.id &&
          row.conversationId === conversationId &&
          row.scope === rootMessageId,
      );
      if (!oldMembers.length && !oldCursors.length && !current) continue;
      const seen = (entry: Entry) => {
        if (!entry.old) return entry.sequence <= (current?.readThroughSequence ?? 0);
        const old = oldMembers.find((row) => row.conversationId === entry.old!.conversationId);
        const cursor = oldCursors.find(
          (row) =>
            row.conversationId === entry.old!.conversationId &&
            row.scope === (entry.old!.threadRootId ?? ""),
        );
        const boundaries = [
          old ? oldBoundary(snapshot, old, entry.old) : undefined,
          cursor?.readThroughSequence,
        ].filter((value): value is number => value !== undefined);
        return boundaries.length > 0 && entry.old.sequence <= Math.min(...boundaries);
      };
      const readThroughSequence = prefix(entries, seen);
      assistantReadMappings.push({
        sessionId: session.id,
        conversationId,
        scope: rootMessageId,
        readThroughSequence,
        reunreadMessages: entries.filter(
          (entry) => entry.sequence > readThroughSequence && seen(entry),
        ).length,
      });
    }
  }
  threadReadMappings.sort((a, b) =>
    `${a.memberId}:${a.rootMessageId}`.localeCompare(`${b.memberId}:${b.rootMessageId}`),
  );
  assistantReadMappings.sort((a, b) =>
    `${a.sessionId}:${a.scope}`.localeCompare(`${b.sessionId}:${b.scope}`),
  );
  return { threadReadMappings, assistantReadMappings };
}
