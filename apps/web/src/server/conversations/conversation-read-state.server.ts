export function othersReadThroughSequence(
  viewerMemberId: string,
  members: readonly {
    id: string;
    agentId?: string | null;
    agent?: { id: string } | null;
    readThroughSequence: number;
    agentReadThroughSequence: number;
  }[],
) {
  return Math.max(
    0,
    ...members
      .filter((member) => member.id !== viewerMemberId)
      .map((member) =>
        (member.agentId ?? member.agent?.id)
          ? member.agentReadThroughSequence
          : member.readThroughSequence,
      ),
  );
}
