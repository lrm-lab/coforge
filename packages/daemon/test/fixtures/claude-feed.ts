import { ClaudeCodeProvider } from "#src/code-agent/claude-code/provider";
import type { AgentSession } from "#src/code-agent/contract";

/** The Claude Code adapter over the stream-json fixture (`claude-stream-json.ts`), launched with
 * the fixture's own arguments. */
export function claudeFixtureProvider(...args: string[]): ClaudeCodeProvider {
  return new ClaudeCodeProvider({
    command: [
      process.execPath,
      new URL("./claude-stream-json.ts", import.meta.url).pathname,
      ...args,
    ],
  });
}

/**
 * A feed of records for the stream-json fixture, which writes every record handed to it once the
 * fixture has seen its first input (at once with the fixture argument `feed-before-input`).
 * Launch the fixture with `environment`, and `attach` its session before sending it any input.
 */
export function claudeEventFeed() {
  const responses: Response[] = [];
  let waiting: ((response: Response) => void) | undefined;
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      responses.shift() ??
      new Promise<Response>((resolve) => {
        waiting = resolve;
      }),
  });
  let session: AgentSession | undefined;
  let serial = 0;
  const markers = new Map<string, () => void>();
  const initialInput = Promise.withResolvers<void>();

  /** Hands the records to the fixture without waiting for the session to read them. */
  function write(...records: Record<string, unknown>[]): void {
    const response = Response.json(records);
    if (waiting) {
      waiting(response);
      waiting = undefined;
    } else responses.push(response);
  }

  /** Writes the records and a usage marker after them, then waits until the session reports the
   * marker, so it has read every record before it. */
  async function writeAndObserve(records: Record<string, unknown>[]): Promise<void> {
    const resetsAt = 1_900_000_000 + ++serial;
    const marker = new Date(resetsAt * 1000).toISOString();
    const observed = new Promise<void>((resolve) => {
      markers.set(marker, resolve);
    });
    write(...records, {
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour", resetsAt },
    });
    await observed;
    markers.delete(marker);
  }

  return {
    environment: { COFORGE_CLAUDE_EVENT_FEED: server.url.href },
    attach(next: AgentSession): void {
      session = next;
      next.subscribe((event) => {
        if (event.type === "text-delta" && event.text === "fixture-input-observed")
          initialInput.resolve();
        if (event.type === "text-delta") markers.get(event.text)?.();
        if (event.type === "usage" && event.snapshot.primary?.resetsAt)
          markers.get(event.snapshot.primary.resetsAt)?.();
      });
    },
    /** The native session id of the attached session. */
    async sessionId(): Promise<string> {
      const identity = await session?.readSessionIdentity?.();
      if (!identity) throw new Error("fixture session identity unavailable");
      return identity.sessionId;
    },
    write,
    /** After the fixture has seen its first input, writes the records and waits until the
     * attached session has read them all. */
    async emit(...records: Record<string, unknown>[]): Promise<void> {
      await initialInput.promise;
      await writeAndObserve(records);
    },
    /** `emit` for a fixture launched with `feed-before-input`, which reads the feed before any
     * input. */
    async emitBeforeInput(...records: Record<string, unknown>[]): Promise<void> {
      await writeAndObserve(records);
    },
    stop(): void {
      server.stop(true);
    },
  };
}

/** The top-level records of a Bash command Claude Code runs in the background: tool call
 * `toolu_<id>` starts task `task-<id>` and returns at once. */
export function backgroundBash(id: string): Record<string, unknown>[] {
  return [
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_use",
            id: `toolu_${id}`,
            name: "Bash",
            input: { command: "sleep 5", run_in_background: true },
          },
        ],
      },
    },
    {
      type: "system",
      subtype: "task_started",
      task_id: `task-${id}`,
      tool_use_id: `toolu_${id}`,
      description: "Sleep 5 seconds",
      is_backgrounded: true,
      task_type: "local_bash",
    },
    {
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: `toolu_${id}`,
            content: `Command running in background with ID: task-${id}.`,
          },
        ],
      },
    },
  ];
}
