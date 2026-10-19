// Opt-in: COFORGE_GROK_E2E_COMMAND=/path/to/grok bun test ./test/grok-native.e2e.ts
// Runs a real Grok CLI against a local model endpoint and an isolated GROK_HOME. No login or
// provider credits required. Writes a repeatable report to .amp/e2e/grok-native/report.json.
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentRuntimeEvent } from "@coforge/agent";
import { GrokProvider } from "#src/code-agent/grok/provider";
import { discoverGrokCatalog } from "#src/code-agent/grok/catalog";
import { readGrokVersion } from "#src/code-agent/grok/version";
import { withDeadline } from "#src/code-agent/deadline";

const command = Bun.env.COFORGE_GROK_E2E_COMMAND;
if (!command) throw new Error("Set COFORGE_GROK_E2E_COMMAND to the installed Grok executable");

type ChatRequest = {
  messages?: { role?: string; content?: unknown }[];
  stream?: boolean;
  tools?: { function?: { name?: string } }[];
};
type ChatReply = { message: Record<string, unknown>; finishReason: string };

/** A local chat-completions endpoint. Only the model API is substituted: the native CLI, ACP
 * catalog and Provider all run. `reply` answers each completion, streamed or not. */
function serveFixtureModel(
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
function writeFixtureConfig(
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

/** The inherited environment with Grok confined to `home`: fixture credentials, no ambient Grok
 * config, and no proxy between the CLI and the local model endpoint. */
function isolatedEnvironment(home: string) {
  return {
    ...Bun.env,
    GROK_HOME: home,
    GROK_AUTH_PATH: join(home, "auth.json"),
    XAI_API_KEY: "fixture-only",
    GROK_CONFIG: "",
    GROK_CONFIG_PATH: "",
    NO_PROXY: "127.0.0.1,localhost",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
  };
}

test("native Grok discovers custom reasoning choices and reports compaction in a resumed turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-grok-native-"));
  try {
    const home = join(root, "grok");
    const cwd = join(root, "workspace");
    const fixturePath = join(cwd, "fixture-context.txt");
    const requests: string[] = [];
    const events: AgentRuntimeEvent[] = [];
    const reports: string[] = [];
    const advertisedTools = new Set<string>();
    let sawStandingInstructions = false;
    let toolMode = false;
    let toolUsed = false;
    let cancelCompaction = false;
    let interruptCompaction = false;
    let interruption: Promise<void> | undefined;
    let interruptionOwnedTurn: boolean | undefined;
    const releaseSummary = Promise.withResolvers<void>();
    let session: AgentSession | undefined;
    let outcome = "failed";
    let version: string | undefined;
    let model: unknown;
    const server = serveFixtureModel(
      async (body) => {
        sawStandingInstructions ||= JSON.stringify(body).includes(
          "Verify the fixture protocol; use no tools unless asked.",
        );
        for (const tool of body.tools ?? [])
          if (tool.function?.name) advertisedTools.add(tool.function.name);
        // Compaction and memory-flush requests also advertise tools on Grok 1.0.62.
        // A fixture tool call belongs to the foreground request, never its summary helper.
        const lastContent = body.messages?.at(-1)?.content;
        const internalSummary =
          typeof lastContent === "string" &&
          (lastContent.startsWith("<user_message>") ||
            lastContent.startsWith("Your task is to produce a faithful"));
        const message: Record<string, unknown> = { role: "assistant" };
        let finishReason = "stop";
        if (
          toolMode &&
          !toolUsed &&
          !internalSummary &&
          body.tools?.some((tool) => tool.function?.name === "read_file")
        ) {
          toolUsed = true;
          finishReason = "tool_calls";
          message.tool_calls = [
            {
              index: 0,
              id: "call-fixture",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ target_file: fixturePath }),
              },
            },
          ];
        } else {
          // Long enough to be a valid compaction summary as well as an ordinary model response.
          message.content =
            "The user requested verification of the native Grok protocol. Completed work includes successful session creation and continuity. Continue using the isolated temporary workspace and local model endpoint; no external actions are needed. ".repeat(
              7,
            );
        }
        // Hold the model at an external boundary so the native compaction cannot finish before
        // the Provider interrupts it. Released in finally even when an assertion fails.
        if (cancelCompaction && toolUsed && finishReason === "stop") await releaseSummary.promise;
        return { message, finishReason };
      },
      {
        usage: { prompt_tokens: 6000, completion_tokens: 100, total_tokens: 6100 },
        onRequest: (path) => requests.push(path),
      },
    );
    try {
      await mkdir(home);
      await mkdir(cwd);
      await Bun.write(fixturePath, "oak maple birch cedar ".repeat(1000));
      await writeFixtureConfig(home, server.port!, 8192, {
        features: ["two_pass_compaction = false"],
        session: ["auto_compact_threshold_percent = 25"],
        model: ['reasoning_efforts = ["low", "high"]', 'reasoning_effort = "high"'],
      });
      const environment = isolatedEnvironment(home);
      version = await readGrokVersion([command!]);
      const catalog = await discoverGrokCatalog([command!], cwd, environment);
      model = catalog?.models.find((entry) => entry.id === "coforge-fixture");
      expect(model).toMatchObject({
        reasoningEfforts: ["low", "high"],
        defaultReasoning: "high",
        recommended: true,
      });
      session = await new GrokProvider({ command: [command!] }).createAgentSession({
        agentWorkspaceDirectory: cwd,
        instructions: "Verify the fixture protocol; use no tools unless asked.",
        runtime: { provider: "grok", model: "coforge-fixture", reasoning: "high" },
        environment,
        onSessionId: async (id) => {
          reports.push(id);
        },
      });
      session.subscribe((event) => {
        events.push(event);
        if (cancelCompaction && event.type === "compaction-interrupted")
          interruptionOwnedTurn = session!.hasLiveTurn;
        if (interruptCompaction && event.type === "compaction-started") {
          interruptCompaction = false;
          interruption = session!.interrupt!();
        }
      });
      const runTurn = async (prompt: string) => {
        const done = Promise.withResolvers<string>();
        const unsubscribe = session!.subscribe((event) => {
          if (event.type === "completed") done.resolve(event.status);
        });
        try {
          await session!.sendMessage(prompt);
          return await withDeadline(
            done.promise,
            30_000,
            () => new Error("Native Grok turn timed out"),
          );
        } finally {
          unsubscribe();
        }
      };
      expect(await runTurn("Verify fixture response.")).toBe("completed");
      expect(sawStandingInstructions).toBe(true);
      const first = await session.readSessionIdentity!();
      expect(await runTurn("Continue the fixture conversation.")).toBe("completed");
      expect((await session.readSessionIdentity!())?.sessionId).toBe(first?.sessionId);
      toolMode = true;
      const before = events.length;
      expect(await runTurn("Read fixture-context.txt then continue.")).toBe("completed");
      expect(events.slice(before).filter((event) => event.type === "tool-end")).toEqual([
        { type: "tool-end", id: "call-fixture", isError: false },
      ]);
      const compactions = events
        .slice(before)
        .filter((event) => event.type.startsWith("compaction-"));
      // A real CLI can compact more than once in this turn. Each successful episode must still
      // report a start and its finish, with no invented failure or missing boundary.
      expect(compactions.length).toBeGreaterThanOrEqual(2);
      expect(compactions.length % 2).toBe(0);
      for (let index = 0; index < compactions.length; index += 2)
        expect(compactions.slice(index, index + 2)).toEqual([
          { type: "compaction-started" },
          { type: "compaction-finished" },
        ]);
      expect((await session.readSessionIdentity!())?.sessionId).toBe(first?.sessionId);
      toolUsed = false;
      cancelCompaction = true;
      interruptCompaction = true;
      const beforeInterrupt = events.length;
      expect(await runTurn("Read fixture-context.txt again then continue.")).toBe("interrupted");
      await interruption;
      expect(
        events.slice(beforeInterrupt).filter((event) => event.type.startsWith("compaction-")),
      ).toEqual([{ type: "compaction-started" }, { type: "compaction-interrupted" }]);
      // The daemon accepts turn Activity only while hasLiveTurn is true.
      expect(interruptionOwnedTurn).toBe(true);
      outcome = "passed";
    } finally {
      releaseSummary.resolve();
      try {
        await session?.dispose();
      } finally {
        await server.stop(true);
        await Bun.write(
          new URL("../../../.amp/e2e/grok-native/report.json", import.meta.url),
          JSON.stringify(
            {
              outcome,
              version,
              model,
              requests,
              advertisedTools: [...advertisedTools],
              toolUsed,
              reports,
              interruptionOwnedTurn,
              events: events.map((event) =>
                event.type === "text-delta" ||
                event.type === "thinking-delta" ||
                event.type === "tool-output"
                  ? { type: event.type }
                  : event,
              ),
            },
            null,
            2,
          ),
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("native ACP admits live interjections, runs a background follow-up and resumes history", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-grok-acp-native-"));
  const cwd = join(root, "workspace");
  const home = join(root, "grok");
  const releasePath = join(cwd, "release-background");
  const firstRequest = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const interjectionSeen = Promise.withResolvers<void>();
  const backgroundRequest = Promise.withResolvers<void>();
  const releaseBackground = Promise.withResolvers<void>();
  let phase: "steer" | "background" | "resume" = "steer";
  let requests = 0;
  let toolIssued = false;
  let foregroundEnded = false;
  let resumedHistory = false;
  let session: AgentSession | undefined;
  let outcome = "failed";
  const events: AgentRuntimeEvent[] = [];
  const wait = <T>(promise: Promise<T>) =>
    withDeadline(promise, 30_000, () => new Error("Native ACP observation timed out"));
  const completed = () => {
    const done = Promise.withResolvers<void>();
    const off = session!.subscribe((event) => {
      if (event.type === "completed") done.resolve();
    });
    return { done: wait(done.promise).finally(off) };
  };
  const server = serveFixtureModel(async (body) => {
    const text = JSON.stringify(body.messages);
    const first = ++requests === 1;
    if (phase === "steer") {
      if (first) {
        firstRequest.resolve();
        await releaseFirst.promise;
      }
      if (text.includes("NATIVE_INTERJECTION_MARKER")) interjectionSeen.resolve();
    }
    if (phase === "resume") resumedHistory ||= text.includes("NATIVE_HISTORY_MARKER");
    const message: Record<string, unknown> = { role: "assistant", content: "Fixture reply." };
    let finishReason = "stop";
    const last = body.messages?.at(-1);
    const helper =
      typeof last?.content === "string" &&
      (last.content.startsWith("<user_message>") ||
        last.content.startsWith("Your task is to produce a faithful") ||
        last.content.includes("Generate a session title"));
    if (phase === "background" && !toolIssued && !helper) {
      toolIssued = true;
      delete message.content;
      finishReason = "tool_calls";
      message.tool_calls = [
        {
          index: 0,
          id: "native-background-command",
          type: "function",
          function: {
            name: "run_terminal_command",
            arguments: JSON.stringify({
              command: `while [ ! -f '${releasePath}' ]; do sleep 0.05; done; printf native-background-finished`,
              description: "Controlled native background completion",
              is_background: true,
              block_until_ms: 0,
            }),
          },
        },
      ];
    } else if (phase === "background" && foregroundEnded && !helper) {
      backgroundRequest.resolve();
      await releaseBackground.promise;
    }
    return { message, finishReason };
  });
  try {
    await mkdir(cwd);
    await mkdir(home);
    await writeFixtureConfig(home, server.port!, 1_000_000);
    const options = {
      agentWorkspaceDirectory: cwd,
      instructions: "Verify isolated native ACP. Use only fixture tools.",
      runtime: { provider: "grok" as const, model: "coforge-fixture", reasoning: "" },
      environment: isolatedEnvironment(home),
    };
    const provider = new GrokProvider({ command: [command!] });
    session = await provider.createAgentSession(options);
    session.subscribe((event) => events.push(event));
    await session.notify!("NATIVE_HISTORY_MARKER");
    await wait(firstRequest.promise);
    expect(session.hasLiveTurn).toBe(true);
    await session.notify!("NATIVE_INTERJECTION_MARKER");
    const steered = completed();
    releaseFirst.resolve();
    await wait(interjectionSeen.promise);
    await steered.done;
    phase = "background";
    const foreground = completed();
    await session.notify!("Start the controlled background command.");
    await foreground.done;
    foregroundEnded = true;
    expect(toolIssued).toBe(true);
    expect(events).toContainEqual({
      type: "tool-end",
      id: "native-background-command",
      isError: false,
    });
    await Bun.write(releasePath, "release");
    await wait(backgroundRequest.promise);
    expect(session.hasLiveTurn).toBe(true);
    const backgroundDone = completed();
    releaseBackground.resolve();
    await backgroundDone.done;
    const identity = await session.readSessionIdentity!();
    await session.dispose();
    phase = "resume";
    session = await provider.createAgentSession({ ...options, sessionId: identity!.sessionId });
    const resumed = completed();
    await session.notify!("Verify restored history.");
    await resumed.done;
    expect(resumedHistory).toBe(true);
    expect((await session.readSessionIdentity!())?.sessionId).toBe(identity!.sessionId);
    outcome = "passed";
  } finally {
    releaseFirst.resolve();
    releaseBackground.resolve();
    await Bun.write(releasePath, "release").catch(() => {});
    try {
      await session?.dispose();
    } finally {
      await server.stop(true);
      await Bun.write(
        new URL("../../../.amp/e2e/grok-native/acp-lifecycle.json", import.meta.url),
        JSON.stringify(
          {
            outcome,
            requests,
            toolIssued,
            foregroundEnded,
            resumedHistory,
            events: events.map((e) => ({
              type: e.type,
              ...(e.type === "completed" ? { status: e.status } : {}),
            })),
          },
          null,
          2,
        ),
      );
      await rm(root, { recursive: true, force: true });
    }
  }
}, 120_000);

test("native ACP replaces a resumed session Grok reports as missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-grok-restore-native-"));
  const cwd = join(root, "workspace");
  const home = join(root, "grok");
  const requested = crypto.randomUUID();
  const reports: { id: string; replaced: string | undefined }[] = [];
  const events: AgentRuntimeEvent[] = [];
  let identity: unknown;
  let status: string | undefined;
  let session: AgentSession | undefined;
  let outcome = "failed";
  const server = serveFixtureModel(() => ({
    message: { role: "assistant", content: "Fixture reply." },
    finishReason: "stop",
  }));
  try {
    await mkdir(cwd);
    await mkdir(home);
    await writeFixtureConfig(home, server.port!, 1_000_000);
    // A never-created ID is Grok's definitive miss (`-32603`, `data.code: FS_NOT_FOUND`).
    session = await new GrokProvider({ command: [command!] }).createAgentSession({
      agentWorkspaceDirectory: cwd,
      instructions: "Verify isolated native restore.",
      runtime: { provider: "grok", model: "coforge-fixture", reasoning: "" },
      sessionId: requested,
      environment: isolatedEnvironment(home),
      onSessionId: async (id, replaced) => {
        reports.push({ id, replaced });
      },
    });
    session.subscribe((event) => events.push(event));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.replaced).toBe(requested);
    expect(reports[0]!.id).not.toBe(requested);
    identity = await session.readSessionIdentity!();
    expect(identity).toEqual({ sessionId: reports[0]!.id, state: "empty" });
    const done = Promise.withResolvers<string>();
    const off = session.subscribe((event) => {
      if (event.type === "completed") done.resolve(event.status);
    });
    try {
      await session.notify!("Verify the replacement session.");
      status = await withDeadline(
        done.promise,
        30_000,
        () => new Error("Native Grok turn timed out"),
      );
    } finally {
      off();
    }
    expect(status).toBe("completed");
    expect((await session.readSessionIdentity!())?.sessionId).toBe(reports[0]!.id);
    outcome = "passed";
  } finally {
    try {
      await session?.dispose();
    } finally {
      await server.stop(true);
      await Bun.write(
        new URL("../../../.amp/e2e/grok-native/restore-missing.json", import.meta.url),
        JSON.stringify(
          {
            outcome,
            requested,
            reports,
            identity,
            status,
            events: events.map((e) => ({
              type: e.type,
              ...(e.type === "completed" ? { status: e.status } : {}),
            })),
          },
          null,
          2,
        ),
      );
      await rm(root, { recursive: true, force: true });
    }
  }
}, 120_000);
