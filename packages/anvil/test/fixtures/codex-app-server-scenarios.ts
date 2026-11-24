import { appendFileSync } from "node:fs";
import { readLines } from "../../../../scripts/test/read-lines";

// A small fake `codex app-server` for protocol scenarios. Scenarios are chosen by argv flags
// (`scenario=<name>`, repeatable) or, per turn, by the turn input text. `log=<path>` appends every
// request the client sends as one JSON line. The full-featured fixture is `./codex-app-server.ts`;
// add scenarios here rather than growing that one.
const scenarios = new Set(
  process.argv
    .filter((argument) => argument.startsWith("scenario="))
    .map((argument) => argument.slice("scenario=".length)),
);
const logPath = process.argv.find((argument) => argument.startsWith("log="))?.slice("log=".length);
const threadId = "thread-1";
const archived = new Set<string>();
const seen = new Set<string>();

let turn = 0;
/** The input of the turn the app-server is running, for interrupt behaviour the turn drives. */
let turnInput = "";

for await (const line of readLines(Bun.stdin.stream())) {
  const text = line.replace(/\r?\n$/, "");
  // Not awaited: a scenario that holds a reply open must keep reading the next request. A
  // failure inside `handle` still has to end the run, or the test waits out its budget instead
  // of reporting what broke.
  if (text)
    void handle(JSON.parse(text) as Message).catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}

interface Message {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  error?: { code?: number };
}

async function handle(message: Message): Promise<void> {
  const { id, method } = message;
  if (logPath && method) appendFileSync(logPath, `${JSON.stringify(message)}\n`);
  if (method === "initialize" && id !== undefined) {
    write({ id, result: { userAgent: "fixture" } });
    return;
  }
  if (method === "skills/list" && id !== undefined) {
    const cwds = message.params?.cwds;
    write({
      id,
      result: {
        data: [
          {
            cwd: Array.isArray(cwds) ? cwds[0] : undefined,
            skills: [],
            errors: [],
          },
        ],
      },
    });
    return;
  }
  if (method === "thread/start" && id !== undefined) {
    write({
      id,
      result: {
        thread: { id: threadId, name: threadName() },
        serviceTier: "default",
        ...openedModel(message.params),
      },
    });
    return;
  }
  if (method === "thread/resume" && id !== undefined) {
    const resumed = String(message.params?.threadId);
    // `archived`: the first resume of a thread finds it archived.
    if (scenarios.has("archived") && !seen.has(resumed)) archived.add(resumed);
    seen.add(resumed);
    if (archived.has(resumed)) {
      const hint = `Run \`codex unarchive ${resumed}\` to unarchive it first.`;
      write({
        id,
        error: {
          code: -32600,
          message: `session ${resumed} is archived. ${hint}`,
        },
      });
    } else if (scenarios.has("active-writer")) {
      write({
        id,
        error: {
          code: -32600,
          message: `session ${resumed} already has an active writer`,
        },
      });
    } else if (scenarios.has("missing-rollout")) {
      write({
        id,
        error: {
          code: -32600,
          message: `no rollout found for thread id ${resumed}`,
        },
      });
    } else {
      if (scenarios.has("resume-usage-baseline")) {
        write({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: resumed,
            turnId: "historical",
            tokenUsage: {
              total: { inputTokens: 502_000, cachedInputTokens: 480_000, outputTokens: 12_500 },
            },
          },
        });
        write({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: resumed,
            turnId: "historical",
            tokenUsage: {
              total: { inputTokens: 500_000, cachedInputTokens: 478_000, outputTokens: 12_000 },
            },
          },
        });
      }
      write({
        id,
        result: {
          thread: { id: resumed, name: threadName() },
          serviceTier: "default",
          ...openedModel(message.params),
        },
      });
    }
    return;
  }
  // `chatgpt` / `api-key`: the sign-in `account/read` reports; `model/list` answers in two pages.
  if (method === "account/read" && id !== undefined) {
    const type = scenarios.has("chatgpt") ? "chatgpt" : "apiKey";
    write({ id, result: { account: { type }, requiresOpenaiAuth: true } });
    return;
  }
  if (method === "model/list" && id !== undefined) {
    const data = message.params?.cursor
      ? [{ model: "gpt-account", isDefault: true }, { model: "gpt-other" }]
      : [{ model: "gpt-hidden", hidden: true, isDefault: true }];
    write({ id, result: { data, nextCursor: message.params?.cursor ? null : "page-2" } });
    return;
  }
  if (method === "thread/unarchive" && id !== undefined) {
    if (scenarios.has("unarchive-fails")) {
      write({
        id,
        error: { code: -32603, message: "failed to unarchive thread" },
      });
      return;
    }
    // `still-archived`: reports success but the thread stays archived.
    if (!scenarios.has("still-archived")) archived.delete(String(message.params?.threadId));
    write({ id, result: { thread: { id: message.params?.threadId } } });
    return;
  }
  if (method === "thread/name/set" && id !== undefined) {
    if (scenarios.has("name-set-fails")) {
      write({ id, error: { code: -32601, message: "method not found" } });
      return;
    }
    write({ id, result: {} });
    return;
  }
  if (method === "thread/compact/start" && id !== undefined) {
    turn += 1;
    const compactTurnId = `turn-compact-${turn}`;
    const targetThread = String(message.params?.threadId ?? threadId);
    write({ id, result: {} });
    if (scenarios.has("slow-compact")) await Bun.sleep(15);
    write({
      method: "turn/started",
      params: { threadId: targetThread, turn: { id: compactTurnId } },
    });
    write({
      method: "item/started",
      params: {
        threadId: targetThread,
        turnId: compactTurnId,
        item: { id: `compact-${turn}`, type: "contextCompaction" },
      },
    });
    if (scenarios.has("slow-compact")) await Bun.sleep(45);
    write({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: targetThread,
        turnId: compactTurnId,
        tokenUsage: {
          modelContextWindow: 400_000,
          last: { totalTokens: 48_000, inputTokens: 46_000, outputTokens: 2_000 },
          total: { totalTokens: 318_000, inputTokens: 300_000, outputTokens: 18_000 },
        },
      },
    });
    write({
      method: "item/completed",
      params: {
        threadId: targetThread,
        turnId: compactTurnId,
        item: { id: `compact-${turn}`, type: "contextCompaction" },
      },
    });
    write({
      method: "turn/completed",
      params: {
        threadId: targetThread,
        turn: { id: compactTurnId, status: "completed" },
      },
    });
    return;
  }
  if (method === "turn/start" && id !== undefined) {
    turn += 1;
    const turnId = `turn-${turn}`;
    turnInput = textInput(message.params) ?? "";
    if (turnInput === "interrupt-while-starting") {
      // Answer `turn/start` only after a long beat, so the interrupt has arrived while the client
      // still waits for this reply and does not yet know the turn id (task #703).
      await Bun.sleep(1_500);
    }
    write({ id, result: { turn: { id: turnId, status: "inProgress" } } });
    write({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    if (scenarios.has("server-request") || textInput(message.params) === "server-request") {
      // Numeric id: the client must echo it unchanged. The turn finishes only on that reply.
      write({
        id: 7,
        method: "item/tool/requestUserInput",
        params: { threadId, turnId, itemId: "ask-1", questions: [] },
      });
      return;
    }
    turnScenario(textInput(message.params), turnId);
    return;
  }
  if (method === "turn/interrupt" && id !== undefined) {
    if (turnInput === "interrupt-after-completion") {
      // The turn completed on its own while the interrupt was in flight, so there is nothing to
      // interrupt: codex answers with an error and sends no further `turn/completed` (task #703).
      completeTurn(`turn-${turn}`);
      write({ id, error: { code: -32600, message: "no active turn to interrupt" } });
      return;
    }
    write({ id, result: {} });
    completeTurn(`turn-${turn}`, "interrupted");
    return;
  }
  if (id === 7 && message.error?.code === -32601) {
    write({
      method: "item/agentMessage/delta",
      params: { threadId, turnId: `turn-${turn}`, itemId: "m1", delta: "Done" },
    });
    completeTurn(`turn-${turn}`);
  }
}

/** The model an opened thread reports, as Codex does, under `chatgpt`/`api-key`: the requested
 * one, else `config-model=<id>`, else a built-in default no fixture account lists. */
function openedModel(params: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!scenarios.has("chatgpt") && !scenarios.has("api-key")) return {};
  const configured = process.argv
    .find((argument) => argument.startsWith("config-model="))
    ?.slice("config-model=".length);
  const model = typeof params?.model === "string" ? params.model : (configured ?? "gpt-builtin");
  return { model, modelProvider: "openai" };
}

function threadName(): string | null {
  return scenarios.has("named-thread") ? "Existing name" : null;
}

/** What a turn does after `turn/started`, picked by its input text; the default ends at once. */
function turnScenario(input: string | undefined, turnId: string): void {
  const notify = (method: string, params: Record<string, unknown>) =>
    write({ method, params: { threadId, ...params } });
  const say = (delta: string) => notify("item/agentMessage/delta", { turnId, itemId: "m1", delta });
  if (input === "resume-usage-reset" || input === "resume-usage-after-reset") {
    const count = (inputTokens: number, outputTokens: number) => ({
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
    });
    if (input === "resume-usage-reset") {
      for (const total of [count(100, 10), count(200, 20)])
        notify("thread/tokenUsage/updated", {
          turnId,
          tokenUsage: { total, last: count(100, 10) },
        });
    } else {
      notify("thread/tokenUsage/updated", { turnId, tokenUsage: { total: count(300, 30) } });
    }
    say("Done");
  }
  if (input === "resume-usage-delta") {
    notify("thread/tokenUsage/updated", {
      turnId,
      tokenUsage: {
        total: { inputTokens: 505_000, cachedInputTokens: 482_400, outputTokens: 13_100 },
      },
    });
    say("Done");
  }
  if (input === "token-usage-only") notify("thread/tokenUsage/updated", { turnId, tokenUsage: {} });
  if (input === "token-usage") {
    // A real reading: the last request against the window, the cumulative total far past it.
    const breakdown = (totalTokens: number) => ({ totalTokens, inputTokens: totalTokens });
    notify("thread/tokenUsage/updated", {
      turnId,
      tokenUsage: {
        last: breakdown(120_000),
        total: breakdown(6_900_000),
        modelContextWindow: 258_400,
      },
    });
    say("Done");
  }
  if (input === "plan-only") {
    // An item kind that maps to no runtime event.
    const item = { type: "plan", id: "p1", text: "" };
    notify("item/started", { turnId, item });
    notify("item/completed", { turnId, item });
  }
  if (input === "tool-only") {
    const item = { type: "commandExecution", id: "cmd-1", command: "true", exitCode: 0 };
    notify("item/started", { turnId, item });
    notify("item/completed", { turnId, item });
  }
  if (input === "text") say("Done");
  if (input === "interrupt-after-completion" || input === "interrupt-while-starting") {
    // A turn still running when the interrupt arrives: these scenarios end it themselves.
    say("Working");
    return;
  }
  if (input === "blank-final") say("  \n");
  if (input === "system-error" || input === "system-error-bare") {
    const status =
      input === "system-error"
        ? { type: "systemError", message: "disk full" }
        : { type: "systemError" };
    notify("thread/status/changed", { status });
    say("Done");
  }
  if (input === "diagnostics") {
    notify("configWarning", { summary: "Bad config", details: null });
    notify("warning", { message: "careful" });
    notify("guardianWarning", { message: "guarded" });
    notify("deprecationNotice", { summary: "Old API", details: "x".repeat(400) });
    notify("thread/status/changed", {
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });
    write({ method: "warning", params: { threadId: "other-thread", message: "elsewhere" } });
    say("Done");
  }
  if (input === "waiting-repeat") {
    const waiting = { type: "active", activeFlags: ["waitingOnApproval"] };
    notify("thread/status/changed", { status: waiting });
    notify("thread/status/changed", { status: waiting });
    notify("thread/status/changed", { status: { type: "active", activeFlags: [] } });
    notify("thread/status/changed", { status: waiting });
    say("Done");
  }
  if (input === "diagnostics-repeat") {
    notify("warning", { message: "careful" });
    notify("warning", { message: "careful" });
    notify("configWarning", { summary: "Bad config", details: null });
    notify("warning", { message: "careful" });
    say("Done");
  }
  if (input === "system-error-bare-repeat") {
    notify("thread/status/changed", { status: { type: "systemError" } });
    notify("thread/status/changed", { status: { type: "systemError" } });
    say("Done");
  }
  const reading = {
    last: { totalTokens: 120_000 },
    total: { totalTokens: 6_900_000 },
    modelContextWindow: 258_400,
  };
  if (input === "token-usage-foreign") {
    // Another thread's reading (a subagent's), then this thread's after its turn completed.
    write({
      method: "thread/tokenUsage/updated",
      params: { threadId: "other-thread", turnId, tokenUsage: reading },
    });
    say("Done");
  }
  const failure = failedTurnError(input);
  if (failure) {
    write({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "failed", error: failure } },
    });
    return;
  }
  completeTurn(turnId, input === "interrupted-empty" ? "interrupted" : "completed");
  if (input === "token-usage-foreign")
    notify("thread/tokenUsage/updated", { turnId, tokenUsage: reading });
}

/** The error a turn started with `input` ends with, when the input names a failing turn. */
function failedTurnError(input: string | undefined): Record<string, unknown> | undefined {
  if (input === "replay-rejected-code")
    return { message: "Bad request", code: "invalid_encrypted_content" };
  if (input === "replay-rejected-text")
    return { message: "Encrypted content could not be decrypted or parsed." };
  // The real TurnError shape: no `code`, the API's text in additionalDetails.
  if (input === "replay-rejected-details")
    return {
      message: "Turn failed",
      codexErrorInfo: "badRequest",
      additionalDetails: "Encrypted content could not be decrypted or parsed.",
    };
  // Codex 0.169.0's reply when a ChatGPT account cannot use the thread's model.
  if (input === "model-not-found")
    return {
      message: "The 'gpt-builtin' model is not supported when using Codex with a ChatGPT account.",
      codexErrorInfo: "modelNotFound",
      additionalDetails: null,
    };
  if (input === "usage-limit")
    return { message: "usage limit reached", code: "usageLimitExceeded" };
  return undefined;
}

function completeTurn(turnId: string, status = "completed"): void {
  write({ method: "turn/completed", params: { threadId, turn: { id: turnId, status } } });
}

function textInput(params: Record<string, unknown> | undefined): string | undefined {
  const first = Array.isArray(params?.input) ? (params.input[0] as unknown) : undefined;
  if (first === null || typeof first !== "object") return undefined;
  return (first as { text?: string }).text;
}

function write(value: unknown): void {
  console.log(JSON.stringify(value));
}
