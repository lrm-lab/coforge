import { expect, test } from "bun:test";
import { extendRequestTimeout } from "#src/server/http/request-timeout.server";
import { openWakeStream } from "#src/server/agents/external-wake-stream.server";

const IDLE_SECONDS = 1;
const HEARTBEAT_MS = 3_000;

async function heartbeatsSeen(extend: boolean): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: IDLE_SECONDS,
    fetch(request, bun) {
      if (extend)
        extendRequestTimeout(Object.assign(request, { runtime: { bun: { server: bun } } }), 30);
      return new Response(
        openWakeStream(
          {
            listHints: async () => [],
            subscribe: () => () => {},
            revalidate: async () => true,
            release: () => {},
            heartbeatMs: HEARTBEAT_MS,
          },
          request.signal,
        ),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + HEARTBEAT_MS + 1_000;
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        Bun.sleep(deadline - Date.now()).then(() => undefined),
      ]).catch(() => ({ done: true, value: undefined }));
      if (!next || next.done) break;
      text += decoder.decode(next.value);
    }
    await reader.cancel().catch(() => {});
    return text.split("event: heartbeat").length - 1;
  } finally {
    await server.stop(true);
  }
}

test("a stream whose heartbeat is slower than the listener's idle timeout stays open", async () => {
  expect(await heartbeatsSeen(true)).toBeGreaterThanOrEqual(1);
}, 20_000);
