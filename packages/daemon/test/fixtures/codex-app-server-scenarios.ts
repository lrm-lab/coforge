import { appendFileSync } from "node:fs";
import { readLines } from "./read-lines";

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

for await (const line of readLines(Bun.stdin.stream())) {
  const text = line.replace(/\r?\n$/, "");
  if (text) handle(JSON.parse(text) as Message);
}

interface Message {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  error?: { code?: number };
}

function handle(message: Message): void {
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
      write({
        id,
        result: {
          thread: { id: resumed, name: threadName() },
          serviceTier: "default",
        },
      });
    }
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
  if (method === "turn/start" && id !== undefined) {
    turn += 1;
    const turnId = `turn-${turn}`;
    write({ id, result: { turn: { id: turnId, status: "inProgress" } } });
    write({
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    if (scenarios.has("server-request") || textInput(message.params) === "server-request") {
      // Token usage keeps the turn from reading as empty without adding an event.
      write({
        method: "thread/tokenUsage/updated",
        params: { threadId, turnId, tokenUsage: {} },
      });
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
  if (id === 7 && message.error?.code === -32601) completeTurn(`turn-${turn}`);
}

function threadName(): string | null {
  return scenarios.has("named-thread") ? "Existing name" : null;
}

/** What a turn does after `turn/started`, picked by its input text; the default ends at once. */
function turnScenario(input: string | undefined, turnId: string): void {
  const notify = (method: string, params: Record<string, unknown>) =>
    write({ method, params: { threadId, ...params } });
  const say = (delta: string) => notify("item/agentMessage/delta", { turnId, itemId: "m1", delta });
  if (input === "token-usage-only") notify("thread/tokenUsage/updated", { turnId, tokenUsage: {} });
  if (input === "plan-only") {
    // An item kind that maps to no runtime event.
    const item = { type: "plan", id: "p1", text: "" };
    notify("item/started", { turnId, item });
    notify("item/completed", { turnId, item });
  }
  if (input === "text") say("Done");
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
  completeTurn(turnId, input === "interrupted-empty" ? "interrupted" : "completed");
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
