import { join } from "node:path";

export function grokReportPath(name: string) {
  return new URL(`../../../../.artifacts/e2e/grok-native/${name}`, import.meta.url);
}

export type ChatRequest = {
  messages?: { role?: string; content?: unknown }[];
  stream?: boolean;
  tools?: { function?: { name?: string } }[];
};
export type ChatReply = { message: Record<string, unknown>; finishReason: string };

/** A local chat-completions endpoint. Only the model API is substituted: the native CLI, ACP
 * catalog and Provider all run. `reply` answers each completion, streamed or not. */
export function serveFixtureModel(
  reply: (body: ChatRequest) => ChatReply | Promise<ChatReply>,
  {
    usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    onRequest,
  }: { usage?: object; onRequest?: (path: string) => void } = {},
) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      onRequest?.(path);
      if (!path.endsWith("/chat/completions"))
        return Response.json({ error: { message: "fixture endpoint" } }, { status: 404 });
      const body = (await request.json()) as ChatRequest;
      const { message, finishReason } = await reply(body);
      const base = { id: "chatcmpl-fixture", model: "coforge-fixture", created: 1 };
      if (!body.stream)
        return Response.json({
          ...base,
          object: "chat.completion",
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage,
        });
      const chunk = (delta: object, finish_reason: string | null) => ({
        ...base,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason }],
      });
      return new Response(
        [
          `data: ${JSON.stringify(chunk(message, null))}\n\n`,
          `data: ${JSON.stringify({ ...chunk({}, finishReason), usage })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
}

/** An isolated Grok config: no updates or remote fetch, and the fixture model at `port` as the
 * default. `extra` lines are appended to the table they name. */
export function writeFixtureConfig(
  home: string,
  port: number,
  contextWindow: number,
  extra: { features?: string[]; session?: string[]; model?: string[] } = {},
) {
  return Bun.write(
    join(home, "config.toml"),
    [
      "[cli]",
      "auto_update = false",
      "[features]",
      "remote_fetch = false",
      ...(extra.features ?? []),
      ...(extra.session ? ["[session]", ...extra.session] : []),
      "[models]",
      'default = "coforge-fixture"',
      "[model.coforge-fixture]",
      'model = "coforge-fixture"',
      `base_url = "http://127.0.0.1:${port}/v1"`,
      'api_key = "fixture-only"',
      `context_window = ${contextWindow}`,
      ...(extra.model ?? []),
      "",
    ].join("\n"),
  );
}
