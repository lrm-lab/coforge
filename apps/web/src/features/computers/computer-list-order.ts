export function orderComputersOwnFirst<T extends { ownedByCurrentUser: boolean }>(
  computers: readonly T[],
): T[] {
  const own: T[] = [];
  const others: T[] = [];
  for (const computer of computers) {
    if (computer.ownedByCurrentUser) own.push(computer);
    else others.push(computer);
  }
  return [...own, ...others];
}
