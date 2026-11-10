import { z } from "zod";
import { piChatResultSchema } from "@lrm/coforge-sdk/internal/pi-chat";
import {
  PI_CHAT_MAX_BYTES,
  PI_CHAT_MAX_PARTS,
  samePiChatScope,
  type PiChatFrame,
  type PiChatRequest,
} from "@lrm/coforge-sdk/internal/pi-chat-wire";
import type { PiChatScope } from "@lrm/coforge-sdk/internal/pi-chat";
import type { PiChatReplyState, PiChatResults } from "./pi-chat-gateway.server";

/** How long a started command can be answered and its reply read. The pending scope is the
 * shorter-lived of the two keys a read needs, so the client stops asking before this ends. */
export const PI_CHAT_REPLY_TTL_SECONDS = 30;
// The pending scope must still exist when a part is committed. Expiry wins atomically.
const ACCEPT = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local parts = redis.call('GET', KEYS[2])
if parts and parts ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ${PI_CHAT_REPLY_TTL_SECONDS})
return redis.call('SET', KEYS[3], ARGV[3], 'EX', ${PI_CHAT_REPLY_TTL_SECONDS}, 'NX') and 1 or 0`;
const replySchema = z.object({
  result: piChatResultSchema.optional(),
  error: z.string().max(1000).optional(),
});
type ResultsRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ex: string, seconds: string): Promise<unknown>;
  send(command: string, args: string[]): Promise<unknown>;
};

/**
 * A short-lived RPC reply cache, never a command mailbox or the conversation's recovery store. A
 * reply is read by the scope it was started for and stays until it expires, so a read whose answer
 * was lost on the way can be asked again.
 */
export class RedisPiChatResults implements PiChatResults {
  constructor(private readonly redis: ResultsRedis) {}
  #prefix(requestId: string) {
    return `coforge:pi-chat:v1:${requestId}`;
  }
  async begin({ requestId, workspaceId, computerId, userId }: PiChatRequest) {
    await this.redis.set(
      `${this.#prefix(requestId)}:pending`,
      JSON.stringify({ requestId, workspaceId, computerId, userId }),
      "EX",
      String(PI_CHAT_REPLY_TTL_SECONDS),
    );
  }
  async accept(frame: PiChatFrame) {
    if (frame.kind !== "result") return;
    const prefix = this.#prefix(frame.frameId);
    const value = await this.redis.get(`${prefix}:pending`);
    if (!value) return;
    const request = JSON.parse(value) as PiChatRequest;
    if (!samePiChatScope(request, frame)) return;
    await this.redis.send("EVAL", [
      ACCEPT,
      "3",
      `${prefix}:pending`,
      `${prefix}:parts`,
      `${prefix}:part:${frame.part}`,
      value,
      String(frame.parts),
      Buffer.from(frame.data).toString("base64"),
    ]);
  }
  async read(scope: PiChatScope, requestId: string): Promise<PiChatReplyState> {
    const prefix = this.#prefix(requestId);
    // One round trip answers the common poll: the scope and the part count, before any part.
    const head = await this.redis.send("MGET", [`${prefix}:pending`, `${prefix}:parts`]);
    const [pending, count] = Array.isArray(head) ? (head as Array<string | null>) : [];
    if (!pending || !samePiChatScope(JSON.parse(pending) as PiChatRequest, scope))
      return { state: "gone" };
    const parts = Number(count);
    if (!Number.isInteger(parts) || parts < 1 || parts > PI_CHAT_MAX_PARTS)
      return { state: "pending" };
    const values = await this.redis.send(
      "MGET",
      Array.from({ length: parts }, (_, part) => `${prefix}:part:${part}`),
    );
    if (
      !Array.isArray(values) ||
      values.length !== parts ||
      values.some((value) => typeof value !== "string")
    )
      return { state: "pending" };
    try {
      const bytes = Buffer.concat(values.map((value: string) => Buffer.from(value, "base64")));
      if (bytes.length > PI_CHAT_MAX_BYTES) throw new Error("Pi chat response too large");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { state: "reply", reply: replySchema.parse(JSON.parse(text)) };
    } catch {
      // A reply that never decodes will not decode on the next read either.
      return { state: "reply", reply: { error: "Pi chat response unreadable" } };
    }
  }
}
