/**
 * A channel the viewer closed and did not pin: its row leaves the list unless a newer message
 * reopens it (`arrivedSinceClosed`). A channel that is not closed, or is pinned, is always listed.
 */
export function isClosedAndUnpinned(channel: {
  members: readonly { hiddenAt: Date | null; pins: readonly unknown[] }[];
}): boolean {
  const member = channel.members[0];
  return member?.hiddenAt != null && member.pins.length === 0;
}
