import { z } from "zod";
import { piChatResultSchema } from "@lrm/coforge-sdk/internal/pi-chat";
import {
  PI_CHAT_MAX_BYTES,
  PI_CHAT_MAX_PARTS,
  samePiChatScope,
  type PiChatFrame,
  type PiChatRequest,
} from "@lrm/coforge-sdk/internal/pi-chat-wire";
import type { PiChatResults } from "./pi-chat-gateway.server";

// The pending scope must still exist when a part is committed. Cancellation/expiry wins atomically.
const ACCEPT = `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local parts = redis.call('GET', KEYS[2])
if parts and parts ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', 30)
return redis.call('SET', KEYS[3], ARGV[3], 'EX', 30, 'NX') and 1 or 0`;
const replySchema = z.object({
  result: piChatResultSchema.optional(),
  error: z.string().max(1000).optional(),
});
type ResultsRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ex: string, seconds: string): Promise<unknown>;
  send(command: string, args: string[]): Promise<unknown>;
};

/** A short-lived RPC reply cache, never a command mailbox or the conversation's recovery store. */
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
      "30",
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
  async read(requestId: string) {
    const prefix = this.#prefix(requestId);
    const parts = Number(await this.redis.get(`${prefix}:parts`));
    if (!Number.isInteger(parts) || parts < 1 || parts > PI_CHAT_MAX_PARTS) return;
    const values = await this.redis.send(
      "MGET",
      Array.from({ length: parts }, (_, part) => `${prefix}:part:${part}`),
    );
    if (
      !Array.isArray(values) ||
      values.length !== parts ||
      values.some((value) => typeof value !== "string")
    )
      return;
    const bytes = Buffer.concat(values.map((value: string) => Buffer.from(value, "base64")));
    if (bytes.length > PI_CHAT_MAX_BYTES) throw new Error("Pi chat response too large");
    return replySchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  }
  async clear(requestId: string) {
    const prefix = this.#prefix(requestId);
    await this.redis.send("DEL", [
      `${prefix}:pending`,
      `${prefix}:parts`,
      ...Array.from({ length: PI_CHAT_MAX_PARTS }, (_, part) => `${prefix}:part:${part}`),
    ]);
  }
}
