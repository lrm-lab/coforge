import { appendFile } from "node:fs/promises";
if (process.argv.includes("--version")) {
  console.log("1.5.0");
  process.exit(0);
}
for (const name of ["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"]) {
  if (Bun.env[name] !== undefined) {
    console.error(`${name} leaked into agy`);
    process.exit(1);
  }
}
const log = Bun.env.AGY_ACP_FIXTURE_LOG;
const configOptions = Bun.env.AGY_ACP_FIXTURE_CONFIG_OPTIONS
  ? JSON.parse(Bun.env.AGY_ACP_FIXTURE_CONFIG_OPTIONS)
  : [];
const sessionId = "agy-acp-fixture-session";
let currentSessionId = sessionId;
const write = (value: unknown) => console.log(JSON.stringify(value));
const update = (value: unknown) =>
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: currentSessionId, update: value },
  });
let prompts = 0;
// A "held" prompt stays in-flight until the next prompt arrives — the steer proof.
let heldReply: (() => void) | undefined;
for await (const line of console) {
  const request = JSON.parse(line);
  if (log) await appendFile(log, `${JSON.stringify(request)}\n`);
  const reply = (result: unknown) => write({ jsonrpc: "2.0", id: request.id, result });
  switch (request.method) {
    case "initialize":
      reply({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          _meta: { antigravity: { systemPrompt: { append: true } } },
        },
        authMethods: [],
      });
      break;
    case "session/new":
    case "session/load":
      if (request.params.sessionId === "missing-session") {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32002, message: "Session not found" },
        });
        break;
      }
      currentSessionId = request.params.sessionId ?? sessionId;
      reply({ sessionId: currentSessionId, configOptions });
      break;
    case "session/set_mode":
    case "session/set_config_option":
      reply({ configOptions: [] });
      break;
    case "session/prompt": {
      const text = request.params.prompt[0].text;
      prompts++;
      if (text === "tool-call") {
        update({
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "Bash",
          rawInput: { command: "ls" },
        });
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          content: [],
        });
      }
      if (Bun.env.AGY_ACP_FIXTURE_HANG) {
        // An accepted prompt emits work then stays live forever: only interrupt/disposal ends it.
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "working" },
        });
        heldReply = () => {};
        break;
      }
      if (heldReply) {
        const flush = heldReply;
        heldReply = undefined;
        flush();
      }
      if (text === "held") {
        // Holds its reply until the next prompt arrives: a second `session/prompt` accepted
        // while this turn runs is the server's steer path.
        heldReply = () => {
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "held-ok" },
          });
          reply({ stopReason: "end_turn" });
        };
        break;
      }
      if (text === "slow") {
        // A steer whose answer takes a while: its work shows at once, the response lands later
        // — a steer offered in between must still join the turn before `completed` fires.
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "slow-working" },
        });
        setTimeout(() => reply({ stopReason: "end_turn" }), 150);
        break;
      }
      if (text === "extra") {
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "extra-working" },
        });
        reply({ stopReason: "end_turn" });
        break;
      }
      reply({ stopReason: text === "refuse" ? "cancelled" : "end_turn" });
      break;
    }
    default:
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
}
