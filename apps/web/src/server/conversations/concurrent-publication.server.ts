export async function publishConcurrently<T>(
  announcement: Promise<unknown>,
  push: () => Promise<T>,
): Promise<T> {
  const [announced, pushed] = await Promise.allSettled([announcement, (async () => push())()]);
  if (pushed.status === "rejected") throw pushed.reason;
  if (announced.status === "rejected") throw announced.reason;
  return pushed.value;
}
