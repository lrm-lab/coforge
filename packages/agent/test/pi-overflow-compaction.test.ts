import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createSession } from "#src/runner";

const modelWindow = 200_000;
const summaryByteLimit = 100_000;
const recentInput = "keep this current user request";
const scenarios = ["accepted", "permanent error", "cancelled"] as const;

function completion(text: string, inputTokens: number) {
  const chunks = [
    { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: inputTokens, completion_tokens: 1, total_tokens: inputTokens + 1 },
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify({ id: "fixture", ...chunk })}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}

test.each(scenarios)("Pi handles overflow compaction when the summary is %s", async (scenario) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "coforge-pi-overflow-"));
  const requests: Array<{ type: string; userCopies: number; bytes: number; status: number }> = [];
  const events: AgentSessionEvent[] = [];
  const estimates: number[] = [];
  let overflowed = false;
  let created: Awaited<ReturnType<typeof createSession>> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const raw = await request.text();
      const bytes = Buffer.byteLength(raw);
      const userCopies = raw.split(recentInput).length - 1;
      if (raw.includes("<conversation>")) {
        const status = bytes > summaryByteLimit ? 400 : scenario === "permanent error" ? 401 : 200;
        requests.push({ type: "summary", userCopies, bytes, status });
        if (scenario === "cancelled") created?.session.abortCompaction();
        if (status === 401) {
          return Response.json({ error: { message: "invalid API key" } }, { status });
        }
        if (status === 200) return completion("fixture summary", 10_000);
      } else if (userCopies === 0) {
        requests.push({ type: "history", userCopies, bytes, status: 200 });
        return completion("fixture history answer", 42_000);
      } else if (overflowed) {
        requests.push({ type: "continue", userCopies, bytes, status: 200 });
        return completion("fixture final answer", 10_000);
      } else {
        overflowed = true;
        requests.push({ type: "overflow", userCopies, bytes, status: 400 });
      }
      return Response.json(
        { error: { message: "maximum context length exceeded", code: "context_length_exceeded" } },
        { status: 400 },
      );
    },
  });
  try {
    await mkdir(join(root, ".builtin-runtime"));
    await Bun.write(
      join(root, ".builtin-runtime", "settings.json"),
      JSON.stringify({
        compaction: { enabled: true, keepRecentTokens: 128, reserveTokens: 1_000 },
        retry: { enabled: false, provider: { maxRetries: 0 } },
      }),
    );
    created = await createSession(
      {
        cwd: root,
        apiKey: "local-test-key",
        modelProvider: "openrouter",
        model: "openai/gpt-4o-mini",
        instructions: "Test only.",
        environment: { NO_PROXY: "*" },
      },
      (pi) => {
        pi.on("session_before_compact", (event) => {
          if (event.reason === "overflow") estimates.push(event.preparation.tokensBefore);
        });
      },
    );
    const { session, sessionId, services } = created;
    services.modelRuntime.registerProvider("openrouter", {
      baseUrl: `${server.url}v1`,
      api: "openai-completions",
    });
    const model = services.modelRuntime.getModel("openrouter", "openai/gpt-4o-mini");
    if (!model) throw new Error("missing fixture model");
    await session.setModel({ ...model, contextWindow: modelWindow, maxTokens: 8_192 });
    session.subscribe((event) => events.push(event));

    const history = "history ".repeat(18_000);
    await session.prompt(history);
    await session.prompt("recent history ".repeat(50));
    const prior = session.sessionManager.getEntries();
    const sessionFile = session.sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("missing fixture session");
    const originalTranscript = await Bun.file(sessionFile).text();
    await session.prompt(recentInput);
    await session.waitForIdle();

    expect(estimates).toHaveLength(1);
    expect(estimates[0]).toBeGreaterThan(36_000);
    expect(estimates[0]).toBeLessThan(modelWindow);
    const continued = scenario === "accepted";
    const summaryStatus = scenario === "permanent error" ? 401 : 200;
    const compaction = events
      .filter((event) => event.type === "compaction_end")
      .map((event) => ({
        reason: event.reason,
        willRetry: event.willRetry,
        aborted: event.aborted,
        summary: event.result?.summary,
        errorMessage: event.errorMessage,
      }));
    expect({
      requests,
      compaction,
      final: session.agent.state.messages.at(-1),
    }).toMatchObject({
      requests: [
        { type: "history", userCopies: 0, status: 200 },
        { type: "history", userCopies: 0, status: 200 },
        { type: "overflow", userCopies: 1, status: 400 },
        { type: "summary", userCopies: 0, status: summaryStatus },
        ...(continued ? [{ type: "continue", userCopies: 1, status: 200 }] : []),
      ],
      compaction: [
        {
          reason: "overflow",
          willRetry: continued,
          aborted: scenario === "cancelled",
          summary: continued ? "fixture summary" : undefined,
        },
      ],
      final: {
        role: continued ? "assistant" : "user",
        content: [{ type: "text", text: continued ? "fixture final answer" : recentInput }],
      },
    });
    expect(compaction[0]?.errorMessage).toEqual(
      scenario === "permanent error"
        ? expect.stringMatching(/Context overflow recovery failed.*401.*invalid API key/)
        : undefined,
    );
    expect(requests.find((request) => request.type === "summary")?.bytes).toBeLessThanOrEqual(
      summaryByteLimit,
    );
    expect(created.sessionId).toBe(sessionId);
    expect(session.sessionManager.getEntries().slice(0, prior.length)).toEqual(prior);
    expect((await Bun.file(sessionFile).text()).startsWith(originalTranscript)).toBe(true);
  } finally {
    await created?.dispose();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
