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

test("native Grok discovers custom reasoning choices and reports compaction in a resumed turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-grok-native-"));
  try {
    const home = join(root, "grok");
    const cwd = join(root, "workspace");
    const fixturePath = join(cwd, "fixture-context.txt");
    const requests: string[] = [];
    const events: AgentRuntimeEvent[] = [];
    const reports: string[] = [];
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
    // Only the model API is substituted. The native CLI, ACP catalog and Provider all run.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push(path);
        if (!path.endsWith("/chat/completions"))
          return Response.json({ error: { message: "fixture endpoint" } }, { status: 404 });
        const body = (await request.json()) as {
          stream?: boolean;
          tools?: { function?: { name?: string } }[];
        };
        const message: Record<string, unknown> = { role: "assistant" };
        let finishReason = "stop";
        if (
          toolMode &&
          !toolUsed &&
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
        const usage = { prompt_tokens: 6000, completion_tokens: 100, total_tokens: 6100 };
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
    try {
      await mkdir(home);
      await mkdir(cwd);
      await Bun.write(fixturePath, "oak maple birch cedar ".repeat(1000));
      await Bun.write(
        join(home, "config.toml"),
        [
          "[cli]",
          "auto_update = false",
          "[features]",
          "remote_fetch = false",
          "two_pass_compaction = false",
          "[session]",
          "auto_compact_threshold_percent = 25",
          "[models]",
          'default = "coforge-fixture"',
          "[model.coforge-fixture]",
          'model = "coforge-fixture"',
          `base_url = "http://127.0.0.1:${server.port}/v1"`,
          'api_key = "fixture-only"',
          "context_window = 8192",
          'reasoning_efforts = ["low", "high"]',
          'reasoning_effort = "high"',
        ].join("\n"),
      );
      const environment = {
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
      version = await readGrokVersion([command!]);
      const catalog = await discoverGrokCatalog([command!], cwd, environment);
      model = catalog?.models.find((entry) => entry.id === "coforge-fixture");
      expect(model).toMatchObject({
        reasoningEfforts: ["low", "high"],
        defaultReasoning: "high",
        recommended: true,
      });
      session = await new GrokProvider({ command: [command!, "--no-leader"] }).createAgentSession({
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
