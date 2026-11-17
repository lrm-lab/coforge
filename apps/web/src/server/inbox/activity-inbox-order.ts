type Ordered = { key: string; latestAt: Date; latestSequence: number };

export const compareActivityOrder = (left: Ordered, right: Ordered) =>
  right.latestAt.getTime() - left.latestAt.getTime() ||
  right.latestSequence - left.latestSequence ||
  (left.key < right.key ? 1 : left.key > right.key ? -1 : 0);
