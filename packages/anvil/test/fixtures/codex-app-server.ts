import { handleCodexMetadata } from "./codex-metadata";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { appliedServiceTier, hasExpectedThreadConfig } from "./codex-models";
import { readLines } from "../../../../scripts/test/read-lines";

const expectedSkill = process.argv
  .find((argument) => argument.startsWith("expected-skill="))
  ?.slice(15);
const expectsCoforgeEnvironment = process.argv.includes("expected-coforge-environment");
const expectsRuntimeConfig = process.argv.includes("expected-runtime-config");
const expectsFastMode = process.argv.includes("expected-fast-mode");
const expectsAgentInstructions = process.argv.includes("expected-agent-instructions");
const expectedSession = process.argv
  .find((argument) => argument.startsWith("expected-session="))
  ?.slice("expected-session=".length);
const threadId = expectedSession && expectedSession !== "new" ? expectedSession : "thread-1";
const usageClient = process.argv.some((argument) => argument.startsWith("usage"));
const skillsDirectory = join(process.cwd(), ".agents", "skills");
let skills: string[] = [];
try {
  skills = await readdir(skillsDirectory);
} catch {
  // No project skills were discovered.
}

let initialized = false;
let skillsLoaded = false;
let turn = 0;
let active = false;

for await (const line of readLines(Bun.stdin.stream())) {
  const text = line.replace(/\r?\n$/, "");
  if (text) handle(JSON.parse(text) as Request);
}

interface Request {
  id?: string;
  method: string;
  params?: Record<string, unknown>;
}

function handle(request: Request): void {
  if (request.method === "initialize" && request.id) {
    const clientInfo = request.params?.clientInfo as Record<string, unknown> | undefined;
    const capabilities = request.params?.capabilities as Record<string, unknown> | undefined;
    const expectedClient = usageClient
      ? { name: "coforge-daemon-usage", title: "CoForge Daemon Usage" }
      : { name: "coforge_daemon", title: "CoForge Daemon" };
    if (
      clientInfo?.name !== expectedClient.name ||
      clientInfo.title !== expectedClient.title ||
      typeof clientInfo.version !== "string" ||
      capabilities?.experimentalApi !== (usageClient ? true : false)
    ) {
      write({
        id: request.id,
        error: { code: "invalid_params", message: "invalid initialize" },
      });
      return;
    }
    write({ id: request.id, result: { userAgent: "fixture" } });
    return;
  }
  if (request.method === "initialized") {
    initialized = true;
    return;
  }
  if (handleCodexMetadata(request, initialized, usageClient, write)) return;
  if (request.method === "skills/list" && request.id && initialized) {
    skillsLoaded = true;
    const cwds = request.params?.cwds;
    const errors =
      expectedSkill && !skills.includes(expectedSkill) ? ["missing expected skill"] : [];
    write({
      id: request.id,
      result: {
        data: [
          {
            cwd: Array.isArray(cwds) ? cwds[0] : undefined,
            skills: skills.map((name) => ({ name })),
            errors,
          },
        ],
      },
    });
    return;
  }
  if (
    ["thread/start", "thread/resume"].includes(request.method) &&
    request.id &&
    initialized &&
    skillsLoaded
  ) {
    if (
      request.params?.sandbox !== "danger-full-access" ||
      request.params?.approvalPolicy !== "never"
    ) {
      write({
        id: request.id,
        error: { message: "wrong approved permission policy" },
      });
      return;
    }
    if (request.method === "thread/resume" && request.params?.threadId !== "thread-1") {
      if (request.params?.threadId === "missing-thread") {
        write({
          id: request.id,
          error: {
            code: -32600,
            message: "no rollout found for thread id missing-thread",
          },
        });
        return;
      }
      if (request.params?.threadId === "unreadable-thread") {
        write({
          id: request.id,
          error: {
            code: -32603,
            message: "failed to read thread: permission denied",
          },
        });
        return;
      }
      write({ id: request.id, error: { message: "unknown saved thread" } });
      return;
    }
    if (expectedSession) {
      const resume = expectedSession !== "new";
      if (
        !request.params ||
        request.method !== (resume ? "thread/resume" : "thread/start") ||
        request.params?.threadId !== (resume ? expectedSession : undefined) ||
        request.params?.ephemeral === true ||
        (resume && ("ephemeral" in request.params || "serviceName" in request.params)) ||
        request.params?.cwd !== process.cwd() ||
        Bun.env.HOME !== Bun.env.COFORGE_EXPECTED_HOME ||
        Bun.env.CODEX_HOME !== Bun.env.COFORGE_EXPECTED_CODEX_HOME
      ) {
        write({
          id: request.id,
          error: { message: "invalid native session configuration" },
        });
        return;
      }
    }
    if (expectsCoforgeEnvironment && !hasCoforgeEnvironmentPolicy(request.params)) {
      write({
        id: request.id,
        error: { message: "missing CoForge shell environment policy" },
      });
      return;
    }
    if (expectsRuntimeConfig && !hasExpectedThreadConfig(request.params, expectsFastMode)) {
      write({
        id: request.id,
        error: { message: "missing selected runtime config" },
      });
      return;
    }
    if (expectsAgentInstructions && !hasAgentInstructions(request.params?.developerInstructions)) {
      write({
        id: request.id,
        error: { message: "missing Agent instructions" },
      });
      return;
    }
    if (request.method === "thread/resume" && process.argv.includes("reject-resume")) {
      write({
        id: request.id,
        error: { code: -32600, message: "session unavailable" },
      });
      return;
    }
    const recoveryError = process.argv
      .find((argument) => argument.startsWith("resume-error="))
      ?.slice("resume-error=".length);
    if (request.method === "thread/resume" && recoveryError) {
      write({
        id: request.id,
        error: { code: -32600, message: recoveryError },
      });
      return;
    }
    write({
      id: request.id,
      result: {
        thread: {
          id: process.argv.includes("wrong-resume-id") ? "wrong-thread" : threadId,
        },
        // Mirrors codex-cli 0.163.0's own reply: a "fast"/"priority" request resolves to
        // "priority", no request at all reports "default", and an unknown value reports null.
        serviceTier: appliedServiceTier(request.params?.serviceTier),
      },
    });
    return;
  }
  if (request.method === "turn/start" && request.id) {
    if (request.params?.threadId !== threadId) throw new Error("wrong session");
    if (active) throw new Error("turn/start while active");
    if (textInput(request.params) === "invalid-turn") {
      write({ id: request.id, result: { turn: {} } });
      return;
    }
    turn += 1;
    active = true;
    const turnId = `turn-${turn}`;
    if (
      ["finish-before-response", "stale-before-response"].includes(textInput(request.params) ?? "")
    ) {
      if (textInput(request.params) === "stale-before-response")
        finishWithLateEvents(`turn-${turn - 1}`);
      write({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, delta: "Completed response" },
      });
      finishWithLateEvents(turnId);
      write({ id: request.id, result: { turn: { id: turnId, status: "completed" } } });
      return;
    }
    write({
      id: request.id,
      result: { turn: { id: turnId, status: "inProgress" } },
    });
    if (textInput(request.params) === "foreign-turn-started") {
      // Another thread's turn, and this thread's turn that already completed, start nothing.
      write({ method: "turn/started", params: { threadId: "other-thread", turn: { id: turnId } } });
      write({ method: "turn/started", params: { threadId, turn: { id: `turn-${turn - 1}` } } });
    }
    write({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    if (
      textInput(request.params) === "retry-error" ||
      textInput(request.params) === "final-error"
    ) {
      write({
        method: "error",
        params: {
          threadId,
          turnId,
          willRetry: textInput(request.params) === "retry-error",
          error: { message: "request timed out: Bearer fixture-private-token" },
        },
      });
      write({ method: "item/agentMessage/delta", params: { delta: "retry observed" } });
      return;
    }
    if (textInput(request.params)?.startsWith("reconnect-stderr:")) {
      console.error(textInput(request.params)!.slice("reconnect-stderr:".length));
      return;
    }
    if (textInput(request.params) === "reasoning-progress") {
      write({
        method: "item/reasoning/textDelta",
        params: { turnId, itemId: "reasoning-progress-1", delta: "thinking about it" },
      });
      write({
        method: "turn/completed",
        params: { turn: { id: turnId, status: "completed" } },
      });
      return;
    }
    if (textInput(request.params) === "reasoning-item") {
      write({
        method: "item/completed",
        params: {
          turnId,
          item: {
            id: "reasoning-1",
            type: "reasoning",
            summary: ["Plan the change"],
            content: ["raw chain of thought"],
          },
        },
      });
      write({
        method: "turn/completed",
        params: { turn: { id: turnId, status: "completed" } },
      });
      return;
    }
    if (textInput(request.params) === "crash") {
      // Exit without responding: the parent observes this as an unexpected
      // process exit, not a requested stop.
      process.exit(1);
    }
    if (textInput(request.params)?.startsWith("race-")) {
      write({
        method: "item/agentMessage/delta",
        params: { delta: `Started: ${textInput(request.params)}` },
      });
    }
    write({
      method: "item/agentMessage/delta",
      params: { turnId, itemId: "message-1", delta: "Codex response" },
    });
    if (textInput(request.params) === "hold-tool") {
      write({
        method: "item/started",
        params: {
          threadId,
          turnId,
          item: { id: "current-command", type: "commandExecution", command: "printf current" },
        },
      });
      return;
    }
    if (
      textInput(request.params) === "finish" ||
      textInput(request.params) === "New message available. Run coforge message check."
    ) {
      write({
        method: "item/started",
        timestamp: "2026-01-02T03:04:05.000Z",
        params: {
          turnId,
          item: {
            id: "item-1",
            type: "commandExecution",
            command: "printf safe",
          },
        },
      });
      write({
        method: "item/commandExecution/outputDelta",
        params: { turnId, itemId: "item-1", delta: "tests passed" },
      });
      write({
        method: "item/completed",
        params: {
          turnId,
          item: { id: "item-1", type: "commandExecution", exitCode: 0 },
        },
      });
      write({
        method: "turn/completed",
        params: { turn: { id: turnId, status: "completed" } },
      });
    } else if (textInput(request.params) === "files") {
      write({
        method: "item/started",
        timestamp: "2026-01-02T03:04:05.000Z",
        params: {
          turnId,
          item: {
            id: "item-2",
            type: "fileChange",
            status: "inProgress",
            changes: [
              { kind: { type: "add" }, path: "src/new.ts", diff: "" },
              { kind: { type: "update", move_path: null }, path: "src/existing.ts", diff: "" },
            ],
          },
        },
      });
      write({
        method: "item/completed",
        params: { turnId, item: { id: "item-2", type: "fileChange", status: "completed" } },
      });
      write({
        method: "turn/completed",
        params: { turn: { id: turnId, status: "completed" } },
      });
    } else if (textInput(request.params) === "official-items") {
      for (const [method, item] of officialItems())
        write({ method, params: { threadId, turnId, item } });
      write({
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: "commentary-1", delta: "Checking the docs" },
      });
      write({
        method: "turn/completed",
        params: { turn: { id: turnId, status: "completed" } },
      });
    } else if (textInput(request.params) === "foreign-turn-started") {
      write({
        method: "turn/completed",
        params: { turn: { id: turnId, status: "completed" } },
      });
    }
    return;
  }
  if (request.method === "turn/steer" && request.id) {
    if (
      request.params?.threadId !== threadId ||
      request.params?.expectedTurnId !== `turn-${turn}`
    ) {
      throw new Error("wrong steering session or turn");
    }
    const text = textInput(request.params);
    if (text === "finish-with-late-events") {
      finishWithLateEvents(`turn-${turn}`);
      // The acknowledgement fences all preceding notifications for the test.
      write({ id: request.id, result: { turnId: `turn-${turn}` } });
      return;
    }
    if (text === "wrong-turn-response") {
      write({ id: request.id, result: { turnId: "wrong-turn" } });
      return;
    }
    if (text === "reject-notice") {
      write({
        id: request.id,
        error: { code: -32600, message: "notification rejected" },
      });
      return;
    }
    if (text === "race-before" || text === "race-after") {
      active = false;
      const completion = {
        method: "turn/completed",
        params: { turn: { id: `turn-${turn}`, status: "completed" } },
      };
      if (text === "race-before") write(completion);
      write({
        id: request.id,
        error: { code: -32600, message: "no active turn to steer" },
      });
      if (text === "race-after") write(completion);
      return;
    }
    write({ id: request.id, result: { turnId: `turn-${turn}` } });
    write({
      method: "item/agentMessage/delta",
      params: { delta: `Steered: ${textInput(request.params)}` },
    });
    return;
  }
  if (request.method === "turn/interrupt" && request.id) {
    write({ id: request.id, result: {} });
    write({
      method: "turn/completed",
      params: { turn: { id: request.params?.turnId, status: "interrupted" } },
    });
  }
}

function textInput(params: Record<string, unknown> | undefined): string | undefined {
  const input = params?.input;
  if (!Array.isArray(input)) return undefined;
  const first = input[0];
  if (first === null || typeof first !== "object") return undefined;
  return (first as { text?: string }).text;
}

function finishWithLateEvents(turnId: string): void {
  write({
    method: "turn/completed",
    params: { threadId, turn: { id: turnId, status: "completed" } },
  });
  write({
    method: "item/started",
    params: {
      threadId,
      turnId,
      item: { id: "late-command", type: "commandExecution", command: "printf late" },
    },
  });
  write({
    method: "item/commandExecution/outputDelta",
    params: { threadId, turnId, itemId: "late-command", delta: "late output" },
  });
  write({
    method: "item/completed",
    params: {
      threadId,
      turnId,
      item: { id: "late-command", type: "commandExecution", exitCode: 0 },
    },
  });
  write({
    method: "item/agentMessage/delta",
    params: { threadId, turnId, delta: "late response" },
  });
  write({
    method: "item/reasoning/summaryTextDelta",
    params: { threadId, turnId, delta: "late summary" },
  });
  write({
    method: "item/reasoning/textDelta",
    params: { threadId, turnId, delta: "late reasoning" },
  });
}

/** One of each official v2 item the Activity mapping reads, in the order a turn reports them. */
function officialItems(): Array<[string, Record<string, unknown>]> {
  const commentary = { type: "agentMessage", id: "commentary-1", text: "", phase: "commentary" };
  const mcp = {
    type: "mcpToolCall",
    id: "mcp-1",
    server: "docs",
    tool: "search",
    status: "inProgress",
    arguments: { query: "retry policy" },
    result: null,
    error: null,
  };
  const review = { type: "enteredReviewMode", id: "review-1", review: "current changes" };
  return [
    ["item/started", commentary],
    ["item/started", mcp],
    ["item/completed", { ...mcp, status: "completed", result: { content: [] } }],
    ["item/started", { type: "contextCompaction", id: "compaction-1" }],
    ["item/completed", { type: "contextCompaction", id: "compaction-1" }],
    ["item/started", review],
    ["item/completed", review],
    ["item/completed", { type: "exitedReviewMode", id: "review-2", review: "Looks good" }],
    [
      "item/completed",
      { type: "agentMessage", id: "answer-1", text: "All done", phase: "final_answer" },
    ],
  ];
}

function hasAgentInstructions(value: unknown): boolean {
  return value === "Test Agent instructions.";
}

function hasCoforgeEnvironmentPolicy(params: Record<string, unknown> | undefined): boolean {
  const config = record(params?.config);
  const policy = record(config?.shell_environment_policy);
  const filters = record(policy?.filters);
  return (
    config?.allow_login_shell === false &&
    config?.["sandbox_workspace_write.network_access"] === true &&
    policy?.inherit === "all" &&
    policy.ignore_default_excludes === false &&
    filters?.["COFORGE_*"] === "include" &&
    filters.PATH === "include" &&
    filters.HOME === "include"
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function write(value: unknown): void {
  if (record(value)?.method === "turn/completed") active = false;
  console.log(JSON.stringify(value));
}
