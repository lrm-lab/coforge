/** Where a `recent` search stopped: the sort key (`createdAt`, millisecond precision like the
 * column) and id of the last message on the page. Opaque to clients. */
export type AgentMessageSearchPosition = { createdAt: Date; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeAgentMessageSearchCursor(position: AgentMessageSearchPosition): string {
  return Buffer.from(
    JSON.stringify({ t: position.createdAt.toISOString(), i: position.id }),
  ).toString("base64url");
}

/** Throws on anything `encodeAgentMessageSearchCursor` could not have produced. */
export function decodeAgentMessageSearchCursor(cursor: string): AgentMessageSearchPosition {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      t?: unknown;
      i?: unknown;
    };
    if (typeof value.t === "string" && typeof value.i === "string" && UUID.test(value.i)) {
      const createdAt = new Date(value.t);
      if (!Number.isNaN(createdAt.getTime()) && createdAt.toISOString() === value.t)
        return { createdAt, id: value.i };
    }
  } catch {
    // Falls through to the single refusal below.
  }
  throw new Error("invalid search cursor");
}
