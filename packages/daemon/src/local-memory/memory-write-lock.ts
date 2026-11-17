const writes = new Map<string, Promise<unknown>>();

export function serializeMemoryWrite<T>(root: string, write: () => Promise<T>): Promise<T> {
  const previous = writes.get(root) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(write);
  writes.set(root, pending);
  void pending
    .finally(() => {
      if (writes.get(root) === pending) writes.delete(root);
    })
    .catch(() => {});
  return pending;
}
