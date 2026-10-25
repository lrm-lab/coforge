/**
 * Settles with `work`, or rejects with `onTimeout()`'s error once `timeoutMs` passes first. The
 * timer is cleared as soon as either settles: a deadline left pending after its work finished
 * would keep the daemon process alive until it fired.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        reject(onTimeout());
      } catch (error) {
        reject(error);
      }
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
