type Ordered = { key: string; latestAt: Date; latestSequence: number; hasUnread?: boolean };

export const compareActivityOrder = (left: Ordered, right: Ordered) =>
  Number(right.hasUnread ?? false) - Number(left.hasUnread ?? false) ||
  right.latestAt.getTime() - left.latestAt.getTime() ||
  right.latestSequence - left.latestSequence ||
  (left.key < right.key ? 1 : left.key > right.key ? -1 : 0);
