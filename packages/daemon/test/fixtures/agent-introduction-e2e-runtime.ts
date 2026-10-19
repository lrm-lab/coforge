import { appendFile, mkdir } from "node:fs/promises";

/**
 * Pi JSONL fixture for the Agent introduction E2E. Logs every prompt turn to `.e2e-turns.jsonl`
 * in the Agent workspace as `{pid, text}`, answers the introduction prompt with one DM to the
 * creator it names, and ends every other turn without action. An introduction prompt whose role
 * description carries `SKIP_INTRODUCTION_MARKER` is logged but never answered, for an Agent whose
 * introduction does not land. Self-contained: the message E2E fixture exports nothing and runs its
 * own protocol loop on import.
 */
const INTRODUCTION_MARKER = "You were just created in CoForge.";
const SKIP_INTRODUCTION_MARKER = "[e2e: skip introduction]";
const INTRODUCTION_BODY = "E2E introduction: I am ready.";

const decoder = new TextDecoder();
let buffer = "";
const requestedSessionIdFlag = process.argv.indexOf("--session-id");
const requestedSessionFileFlag = process.argv.indexOf("--session");
const sessionFile =
  requestedSessionFileFlag >= 0 ? process.argv[requestedSessionFileFlag + 1] : undefined;
const sessionHeader = sessionFile ? await Bun.file(sessionFile).json() : undefined;
const sessionId =
  requestedSessionIdFlag >= 0
    ? process.argv[requestedSessionIdFlag + 1] || ""
    : typeof sessionHeader?.id === "string"
      ? sessionHeader.id
      : "e2e-session";

type Command = { id: string; type: string; message?: string };

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line) await handle(JSON.parse(line) as Command);
    newline = buffer.indexOf("\n");
  }
}

async function handle(command: Command) {
  if (command.type === "get_state" || command.type === "get_commands") {
    await mkdir(".pi-sessions", { recursive: true });
    await Bun.write(
      `.pi-sessions/${sessionId}.jsonl`,
      `${JSON.stringify({ type: "session", id: sessionId, cwd: process.cwd() })}\n`,
    );
    respond(
      command,
      command.type === "get_state" ? { sessionId, ...(sessionFile ? { sessionFile } : {}) } : {},
    );
    return;
  }
  if (command.type === "prompt") {
    respond(command);
    const text = command.message ?? "";
    await appendFile(".e2e-turns.jsonl", `${JSON.stringify({ pid: process.pid, text })}\n`);
    if (text.startsWith(INTRODUCTION_MARKER) && !text.includes(SKIP_INTRODUCTION_MARKER)) {
      try {
        await introduce(text);
      } catch (error) {
        await Bun.write(
          ".e2e-agent-error",
          error instanceof Error ? error.message : "Agent introduction E2E failed",
        );
        process.exit(1);
      }
    }
    // Every turn ends here, so the session is idle for the next prompt.
    write({ type: "agent_settled" });
    return;
  }
  if (
    command.type === "set_model" ||
    command.type === "set_thinking_level" ||
    command.type === "clear_queue" ||
    command.type === "abort"
  ) {
    respond(command);
    if (command.type === "abort") write({ type: "agent_settled" });
  }
}

async function introduce(prompt: string) {
  const creator = prompt.match(/introduce yourself to @(\S+?),/)?.[1];
  if (!creator) throw new Error("creator handle missing from the introduction prompt");
  const target = `@${creator}`;
  let sent = await call({ operation: "send", target, content: INTRODUCTION_BODY });
  if (sent.accepted === false && sent.sideEffectDecision === "hold") {
    // A first touch may be held for review: read the target, then send the draft.
    await call({ operation: "read", target });
    sent = await call({ operation: "send", target, sendDraft: true });
  }
  if (!sent.messageId) throw new Error(`introduction was not sent: ${JSON.stringify(sent)}`);
  await Bun.write(
    ".e2e-introduction-sent.json",
    JSON.stringify({ pid: process.pid, target, messageId: sent.messageId }),
  );
}

/** One Agent proxy call, as `coforge message` makes it; the idempotency key is stable. */
async function call(input: {
  operation: "read" | "send";
  target: string;
  content?: string;
  sendDraft?: boolean;
}) {
  const response = await fetch(process.env.COFORGE_AGENT_PROXY_URL!, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.COFORGE_AGENT_CONTEXT}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...input,
      idempotencyKey: input.operation === "send" ? "e2e-introduction" : "e2e-introduction-read",
    }),
  });
  if (!response.ok) throw new Error(`proxy failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as {
    accepted?: boolean;
    sideEffectDecision?: string;
    messageId?: string;
  };
}

function respond(command: Command, data?: unknown) {
  write({
    type: "response",
    id: command.id,
    command: command.type,
    success: true,
    ...(data ? { data } : {}),
  });
}

function write(value: unknown) {
  console.log(JSON.stringify(value));
}
