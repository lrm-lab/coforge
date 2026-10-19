import { appendFile } from "node:fs/promises";
if (process.argv.includes("--version")) {
  console.log("grok 1.0.62 (fixture)");
  process.exit(0);
}
const log = Bun.env.COFORGE_GROK_ACP_LOG!;
const sessionId = "0195d5a0-4b2e-7c11-9a53-3f2f6b1d7e10";
const write = (record: unknown) => console.log(JSON.stringify(record));
const note = (method: string, params: unknown) => write({ jsonrpc: "2.0", method, params });
const update = (value: unknown) => note("session/update", { sessionId, update: value });
let pending: { id: string; promptId: string } | undefined;
let awaitingPermission: { id: string; promptId: string; answers: number } | undefined;
const terminal = (promptId: string, stopReason = "end_turn") =>
  note("_x.ai/session_notification", {
    sessionId,
    update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: stopReason },
  });
const askPermission = (id: string, forSession: string) =>
  write({
    jsonrpc: "2.0",
    id,
    method: "session/request_permission",
    params: {
      sessionId: forSession,
      toolCall: { toolCallId: "tool-permission", title: "Run shell", status: "pending" },
      options: [
        { optionId: "always", name: "Always allow", kind: "allow_always" },
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  });
for await (const line of console) {
  const request = JSON.parse(line);
  const params = request.params ?? {};
  await appendFile(
    log,
    `${JSON.stringify({ ...request, pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd() })}\n`,
  );
  const reply = (result: unknown) => write({ jsonrpc: "2.0", id: request.id, result });
  // The client's answers to both permission requests settle the turn that asked.
  if (!request.method && awaitingPermission && String(request.id).startsWith("permission-")) {
    if (++awaitingPermission.answers === 2) {
      terminal(awaitingPermission.promptId);
      write({ jsonrpc: "2.0", id: awaitingPermission.id, result: { stopReason: "end_turn" } });
      awaitingPermission = undefined;
    }
    continue;
  }
  switch (request.method) {
    case "initialize":
      reply({
        protocolVersion: 1,
        agentCapabilities: { loadSession: Bun.env.COFORGE_GROK_MODE !== "no-load-session" },
        authMethods: [{ id: "cached_token", name: "Cached token" }],
      });
      break;
    case "authenticate":
      reply({});
      break;
    case "session/new":
      reply({ sessionId });
      break;
    case "session/set_model":
      // A background turn that starts and finishes before the session is reported.
      if (params.modelId === "pre-ready-background") {
        note("_x.ai/queue/changed", {
          sessionId,
          entries: [],
          runningPromptId: "background-early",
        });
        terminal("background-early");
      }
      reply({});
      break;
    case "session/load":
      if (params.sessionId === "missing" || params.sessionId === "offline") {
        write({
          jsonrpc: "2.0",
          id: request.id,
          // Grok 1.0.62's io_error_to_acp shapes: a definitive miss, and another I/O failure.
          error:
            params.sessionId === "missing"
              ? {
                  code: -32603,
                  message: "Path not found.",
                  data: { detail: "No such file or directory (os error 2)", code: "FS_NOT_FOUND" },
                }
              : {
                  code: -32603,
                  message: "An unexpected I/O error occurred.",
                  data: { detail: "Connection reset by peer (os error 54)", code: "FS_OTHER" },
                },
        });
        break;
      }
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "replayed history" },
      });
      terminal("historical-prompt");
      reply({});
      break;
    case "session/cancel":
      if (pending) {
        note("_x.ai/session_notification", {
          sessionId,
          update: {
            sessionUpdate: "turn_completed",
            prompt_id: pending.promptId,
            stop_reason: "cancelled",
          },
        });
        write({ jsonrpc: "2.0", id: pending.id, result: { stopReason: "cancelled" } });
        pending = undefined;
      }
      break;
    case "_x.ai/interject": {
      if (params.text === "reject") {
        reply({ result: null, error: "interjection refused" });
        break;
      }
      // Grok 1.0.62's only refusal: invalid_params for a session it does not hold.
      if (params.text === "refuse rpc") {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32602,
            message: "Invalid params",
            data: `session not found: ${sessionId}`,
          },
        });
        break;
      }
      if (params.text === "exit before reply") process.exit(9);
      if (pending) {
        terminal(pending.promptId);
        write({ jsonrpc: "2.0", id: pending.id, result: { stopReason: "end_turn" } });
        pending = undefined;
        note("_x.ai/queue/changed", { sessionId, entries: [], runningPromptId: "background-1" });
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "background started" },
        });
      } else terminal("background-1");
      reply({ result: { status: "queued" } });
      if (params.text === "crash background") process.exit(7);
      break;
    }
    case "session/prompt": {
      const promptId = params._meta.promptId;
      // Unadmitted: the observable sync point is an unrelated autonomous turn's update.
      if (params.prompt[0].text === "hold admission") {
        note("_x.ai/queue/changed", { sessionId, entries: [], runningPromptId: "background-hold" });
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "waiting for admission" },
        });
        break;
      }
      // Grok streams the prompt's own updates without any queue notification.
      if (params.prompt[0].text === "stream admission") {
        note("session/update", {
          sessionId,
          _meta: { promptId },
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "streamed admission" },
          },
        });
        pending = { id: request.id, promptId };
        break;
      }
      if (params.prompt[0].text === "prompt error") {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32603,
            message: "Internal error",
            data: { detail: "model backend unavailable", code: "SAMPLING_ERROR" },
          },
        });
        break;
      }
      note("_x.ai/queue/changed", {
        sessionId,
        entries: [
          { id: promptId, version: 0, kind: "prompt", text: params.prompt[0].text, position: 0 },
        ],
      });
      note("_x.ai/queue/changed", { sessionId, entries: [], runningPromptId: promptId });
      if (params.prompt[0].text === "display") {
        update({
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "Read file",
          _meta: { "x.ai/tool": { name: "read_file" } },
          rawInput: { target_file: "notes.txt" },
          status: "in_progress",
          kind: "read",
        });
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "display output" } }],
          rawOutput: { secret: "never display raw output" },
        });
        update({
          sessionUpdate: "tool_call",
          toolCallId: "tool-2",
          title: "Run shell",
          _meta: { "x.ai/tool": { name: "run_terminal_cmd" } },
          rawInput: { command: "sleep 100" },
          status: "in_progress",
          kind: "execute",
        });
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-2",
          status: "cancelled",
          content: [{ type: "content", content: { type: "text", text: "partial output" } }],
        });
        for (const sessionUpdate of [
          "auto_compact_started",
          "auto_compact_failed",
          "auto_compact_started",
          "auto_compact_completed",
        ])
          note("_x.ai/session_notification", {
            sessionId,
            update: { sessionUpdate, error: "compaction diagnostic" },
          });
      }
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello from grok" },
      });
      if (params.prompt[0].text === "held" || Bun.env.COFORGE_GROK_MODE === "hang") {
        pending = { id: request.id, promptId };
        break;
      }
      if (params.prompt[0].text === "permission") {
        awaitingPermission = { id: request.id, promptId, answers: 0 };
        askPermission("permission-other", "another-session");
        askPermission("permission-own", sessionId);
        break;
      }
      // Grok's turn_completed carries "error" for a failed turn.
      const stopReasons: Record<string, string> = { fail: "error", "max tokens": "max_tokens" };
      terminal(promptId, stopReasons[params.prompt[0].text] ?? "end_turn");
      reply({ stopReason: "end_turn", _meta: { promptId } });
      break;
    }
  }
}
