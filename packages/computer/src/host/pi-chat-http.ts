import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { signPiChatRequest } from "@lrm/coforge-sdk/internal/pi-chat-auth";
import {
  piChatCommandSchema,
  piChatScopeSchema,
  type PiChatCommand,
  type PiChatResult,
  type PiChatScope,
} from "@lrm/coforge-sdk/internal/pi-chat";

export { signPiChatRequest };

/** The private host trusts only the platform's signed, time-bounded scope assertion. */
export function createPiChatHandler(input: {
  secret: string;
  now?: () => number;
  execute(scope: PiChatScope, command: PiChatCommand): Promise<PiChatResult>;
}) {
  const envelope = z.object({ scope: piChatScopeSchema, command: piChatCommandSchema });
  return async (request: Request): Promise<Response | undefined> => {
    if (new URL(request.url).pathname !== "/pi-chat/v1") return undefined;
    const json = (value: unknown, status = 200) =>
      Response.json(value, { status, headers: { "cache-control": "no-store" } });
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
    // Bound the stream as well as Content-Length; chunked bodies cannot bypass the limit.
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "invalid request" }, 400);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > 512_000) {
          await reader.cancel();
          return json({ error: "request too large" }, 413);
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const body = new TextDecoder().decode(combined);
    const time = Number(request.headers.get("x-coforge-chat-time"));
    const signature = request.headers.get("x-coforge-chat-signature") ?? "";
    const expected = signPiChatRequest(input.secret, time, body);
    if (
      !Number.isSafeInteger(time) ||
      Math.abs((input.now ?? Date.now)() - time) > 30_000 ||
      !/^[\da-f]{64}$/.test(signature) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    ) {
      return json({ error: "unauthorized" }, 401);
    }
    let parsed: z.infer<typeof envelope>;
    try {
      parsed = envelope.parse(JSON.parse(body));
    } catch {
      return json({ error: "invalid request" }, 400);
    }
    try {
      return json(await input.execute(parsed.scope, parsed.command));
    } catch {
      return json(
        { error: "Pi request failed. Check the cloud computer and its model configuration." },
        503,
      );
    }
  };
}
