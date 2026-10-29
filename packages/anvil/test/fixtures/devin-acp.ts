import { appendFile } from "node:fs/promises";

if (process.argv.includes("--version")) {
  console.log("devin 3000.11.228 (053434014dbd)");
  process.exit(0);
}

const log = Bun.env.DEVIN_FIXTURE_LOG!;
const sessionId = "devin-fixture-session";
let currentModel = "gpt-6-sol-high";
let currentEffort = "high";
let currentMode = "accept-edits";
const modelOptions = [
  {
    value: "gpt-6-sol-high",
    name: "GPT-6 Sol High",
    description: "Thinking high",
  },
  {
    value: "gpt-6-sol-low",
    name: "GPT-6 Sol Low",
    description: "Thinking low",
  },
  {
    value: "claude-opus-5-5-medium",
    name: "Claude Opus 5.5 Medium",
    description: "",
  },
];
const effortOptions = [
  { value: "none", name: "None" },
  { value: "low", name: "Low" },
  { value: "high", name: "High" },
  { value: "max", name: "Max" },
];
function configOptions() {
  return [
    {
      id: "mode",
      name: "Session Mode",
      category: "mode",
      type: "select",
      currentValue: currentMode,
      options: [
        { value: "accept-edits", name: "Code" },
        { value: "bypass", name: "Bypass Permissions" },
      ],
    },
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: modelOptions,
    },
    {
      id: "thought_level",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: currentEffort,
      options: effortOptions,
    },
  ];
}
function applyConfig(configId: unknown, value: unknown) {
  if (typeof value !== "string") return;
  if (configId === "model" && modelOptions.some((entry) => entry.value === value)) {
    currentModel = value;
    currentEffort = value.endsWith("-low") ? "low" : "high";
    return;
  }
  if (configId === "thought_level" && effortOptions.some((entry) => entry.value === value))
    currentEffort = value;
  if (configId === "mode") currentMode = value;
}
const write = (value: unknown) => console.log(JSON.stringify(value));
const update = (value: unknown) =>
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId, update: value },
  });
let held: unknown;
for await (const line of console) {
  const request = JSON.parse(line);
  await appendFile(log, `${JSON.stringify(request)}\n`);
  const reply = (result: unknown) => write({ jsonrpc: "2.0", id: request.id, result });
  switch (request.method) {
    case "initialize":
      if (Bun.env.DEVIN_FIXTURE_STDERR === "1") console.error("auth failed sk-abcdefghijklmnop");
      reply({
        protocolVersion: Bun.env.DEVIN_FIXTURE_PROTOCOL === "0" ? 0 : 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { close: {} },
        },
        authMethods: [{ id: "devin-browser", name: "Log in with browser" }],
      });
      break;
    case "session/new":
      reply({ sessionId, configOptions: configOptions() });
      break;
    case "session/load":
      // Devin CLI 3000.11.228's reply for a session it no longer has.
      if (request.params?.sessionId === "missing-session") {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32016,
            message: "Session not found",
            data: {
              "cognition.ai/errorKind": "session_not_found",
              "cognition.ai/retryable": false,
            },
          },
        });
        break;
      }
      if (request.params?.sessionId === "unreadable-session") {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32603,
            message: "Session not found in a corrupt store",
          },
        });
        break;
      }
      reply({
        modes: { currentModeId: currentMode },
        configOptions: configOptions(),
      });
      break;
    case "session/set_mode":
      currentMode = String(request.params?.modeId ?? currentMode);
      reply({});
      break;
    case "session/set_config_option":
      applyConfig(request.params?.configId, request.params?.value);
      reply({ configOptions: configOptions() });
      break;
    case "session/prompt": {
      const text = request.params.prompt[0].text;
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "working" },
      });
      if (text === "crash") process.exit(1);
      if (text === "hold") {
        held = request.id;
        break;
      }
      if (text === "tool") {
        update({
          sessionUpdate: "tool_call",
          toolCallId: "shell-1",
          title: "Shell: printf hi",
          kind: "execute",
          rawInput: { command: "printf hi" },
        });
        // ACP resends the call's whole content on every update, exactly as the real CLI does.
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "shell-1",
          content: [{ type: "content", content: { type: "text", text: "hi" } }],
        });
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "shell-1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "hi" } }],
        });
      }
      reply({ stopReason: "end_turn" });
      break;
    }
    case "session/cancel":
    case "fixture/release":
      if (held !== undefined)
        write({
          jsonrpc: "2.0",
          id: held,
          result: {
            stopReason: request.method === "session/cancel" ? "cancelled" : "end_turn",
          },
        });
      held = undefined;
      break;
    case "session/close":
      reply({});
      break;
  }
}
