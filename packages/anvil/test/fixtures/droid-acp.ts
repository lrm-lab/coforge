import { appendFile, mkdir } from "node:fs/promises";
if (process.argv.includes("--version")) {
  console.log("1.4.1");
  process.exit(0);
}
const log = Bun.env.DROID_ACP_FIXTURE_LOG;
/** The standing instructions arrive as a file path, exactly the way the session builds them. */
const instructionsFlag = process.argv.indexOf("--append-system-prompt-file");
const instructionsPath = instructionsFlag === -1 ? undefined : process.argv[instructionsFlag + 1];
let instructionsText = "";
if (Bun.env.DROID_ACP_FIXTURE_REQUIRE_INSTRUCTIONS) {
  instructionsText = instructionsPath ? await Bun.file(instructionsPath).text() : "";
  if (!instructionsText) {
    console.error("--append-system-prompt-file missing or unreadable");
    process.exit(1);
  }
}
if (log)
  await appendFile(log, `${JSON.stringify({ argv: process.argv.slice(2), instructionsText })}\n`);
const modelOptions = [
  { value: "auto", name: "Auto Model" },
  { value: "claude-sonnet-5", name: "Sonnet 5" },
  { value: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
];
let configOptions = [
  {
    id: "autonomy_level",
    name: "Autonomy Level",
    category: "mode",
    type: "select",
    currentValue: "auto-medium",
    options: [{ value: "normal" }, { value: "auto-medium" }],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gpt-6.1-sol",
    options: modelOptions,
  },
  {
    id: "reasoning_effort",
    name: "Reasoning Effort",
    category: "thought_level",
    type: "select",
    currentValue: "high",
    options: [{ value: "low" }, { value: "high" }, { value: "max" }],
  },
];
const sessionId = "droid-acp-fixture-session";
let currentSessionId = sessionId;
const stateDirectory = Bun.env.DROID_ACP_FIXTURE_STATE;
const statePath = (id: string) => `${stateDirectory}/${id}.jsonl`;
const recordPrompt = async (id: string, text: string) => {
  if (!stateDirectory) return;
  await mkdir(stateDirectory, { recursive: true });
  await appendFile(statePath(id), `${JSON.stringify(text)}\n`);
};
let restored: string[] = [];
const write = (value: unknown) => console.log(JSON.stringify(value));
const update = (value: unknown) =>
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: currentSessionId, update: value },
  });
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
          sessionCapabilities: { list: {}, resume: {}, close: {}, fork: {} },
          auth: { logout: {} },
        },
        agentInfo: { name: "@factory/cli", title: "Factory Droid", version: "1.4.1" },
        authMethods: [
          { id: "device-pairing", name: "Login" },
          { id: "factory-api-key", name: "Factory API Key" },
        ],
      });
      break;
    case "session/new":
    case "session/load":
      if (request.method === "session/load" && request.params.sessionId === "missing-session") {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32602,
            message: "Invalid params: Unknown session identifier",
            data: { sessionId: request.params.sessionId },
          },
        });
        break;
      }
      currentSessionId = request.params.sessionId ?? sessionId;
      if (request.method === "session/load" && stateDirectory) {
        const stored = await Bun.file(statePath(currentSessionId))
          .text()
          .catch(() => "");
        restored = stored
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string);
      }
      reply({ sessionId: currentSessionId, configOptions });
      break;
    case "session/set_config_option": {
      const offered = configOptions
        .find((entry) => entry.id === request.params.configId)
        ?.options.some((option) => option.value === request.params.value);
      if (!offered) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: "Invalid params: unknown option value" },
        });
        break;
      }
      configOptions = configOptions.map((entry) =>
        entry.id === request.params.configId
          ? { ...entry, currentValue: request.params.value }
          : entry,
      );
      reply({ configOptions });
      break;
    }
    case "session/prompt": {
      const text = request.params.prompt[0].text;
      if (text === "crash") {
        console.error("droid acp: fatal internal error, aborting");
        process.exit(1);
      }
      if (restored.length) {
        const recalled = restored;
        restored = [];
        for (const text of recalled)
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `recalled ${text}` },
          });
      }
      await recordPrompt(currentSessionId, text);
      if (Bun.env.DROID_ACP_FIXTURE_HANG) {
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "working" },
        });
        break;
      }
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
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `echo ${text}` },
      });
      // The real server reports the session's context reading with each turn's answer.
      update({ sessionUpdate: "usage_update", used: 348, size: 250_000 });
      reply({ stopReason: "end_turn" });
      break;
    }
    default:
      // `session/cancel` is `-32601` on the real server, which is why an interrupt kills it.
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `"Method not found": ${request.method}` },
      });
  }
}
