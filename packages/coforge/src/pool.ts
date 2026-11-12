/** Runs `fn` over `items`, a few at a time, stopping at the first failure. */
export async function inPool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length)
      try {
        await fn(items[next++]!);
      } catch (error) {
        failed = true;
        throw error;
      }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}
