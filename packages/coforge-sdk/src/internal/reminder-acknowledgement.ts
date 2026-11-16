/** Stable UUIDv5 key shared by the CLI, daemon and server for one acknowledgement intent. */
export function reminderAcknowledgementIdempotencyKey(
  operation: "ack" | "dismiss",
  reminderId: string,
  revision: number,
): string {
  const bun = (
    globalThis as typeof globalThis & {
      Bun?: { randomUUIDv5(name: string, namespace: string): string };
    }
  ).Bun;
  if (!bun) throw new Error("UUIDv5 reminder keys require the Bun runtime");
  return bun.randomUUIDv5(
    `reminder:${operation}:${reminderId}:${revision}`,
    "f1c9b0e4-7a4d-5b6c-8d2e-91f3a5c7e9b0",
  );
}
