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
const terminal = (promptId: string) =>
  note("_x.ai/session_notification", {
    sessionId,
    update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn" },
  });
for await (const line of console) {
  const request = JSON.parse(line);
  const params = request.params ?? {};
  await appendFile(
    log,
    `${JSON.stringify({ ...request, pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd() })}\n`,
  );
  const reply = (result: unknown) => write({ jsonrpc: "2.0", id: request.id, result });
  switch (request.method) {
    case "initialize":
      reply({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
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
      reply({});
      break;
    case "session/load":
      if (params.sessionId === "missing" || params.sessionId === "offline") {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32603,
            message: "Internal error",
            data:
              params.sessionId === "missing"
                ? "Failed to restore session from remote: 404 Not Found"
                : "Remote temporarily unavailable",
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
      if (params.prompt[0].text === "hold admission") {
        note("session/update", {
          sessionId,
          _meta: { promptId },
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "waiting for admission" },
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
      note("_x.ai/session_notification", {
        sessionId,
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: promptId,
          stop_reason: params.prompt[0].text === "fail" ? "max_tokens" : "end_turn",
        },
      });
      reply({ stopReason: "end_turn", _meta: { promptId } });
      break;
    }
  }
}
