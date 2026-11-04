import { appendFile, mkdir } from "node:fs/promises";
if (process.argv.includes("--version")) {
  console.log("2026.10.22-27dcf5f");
  process.exit(0);
}

// Cursor ACP fixture: cursor-agent acp over stdio JSON-RPC. CURSOR_ACP_FIXTURE_LOG records every
// inbound request plus the workspace's private rule file when one exists. CURSOR_ACP_FIXTURE_HANG
// accepts prompts without replying, CURSOR_ACP_FIXTURE_QUOTA refuses with 429, STATE keeps
// per-session prompts across processes, MODELS overrides the listed composite ids, and NO_MODELS
// strips the models block entirely.
const logPath = Bun.env.CURSOR_ACP_FIXTURE_LOG;
// The private rule file is written before the server spawns — read it once, so request logging
// stays a plain append and never lags the test's reads.
const privateRule = await (async () => {
  const { readdir } = await import("node:fs/promises");
  return readdir(`${process.cwd()}/.cursor/rules`)
    .then((names) => names.find((name) => name.startsWith("coforge-agent")) ?? null)
    .catch(() => null);
})();
const log = async (value: unknown) => {
  if (!logPath) return;
  await appendFile(logPath, `${JSON.stringify({ ...(value as object), privateRule })}\n`);
};

const composite = (id: string) => ({ modelId: id, name: id.split("[")[0] });
const defaultModels = [
  { modelId: "default[]", name: "Auto" },
  composite("claude-sonnet-5[thinking=true,context=300k,effort=high]"),
  composite("claude-sonnet-5[thinking=true,context=300k,effort=medium]"),
  composite("gpt-5.5[context=272k,reasoning=medium,fast=false]"),
];
const listedModels = Bun.env.CURSOR_ACP_FIXTURE_NO_MODELS
  ? []
  : Bun.env.CURSOR_ACP_FIXTURE_MODELS
    ? JSON.parse(Bun.env.CURSOR_ACP_FIXTURE_MODELS)
    : defaultModels;
const defaultConfigOptions = Bun.env.CURSOR_ACP_FIXTURE_NO_MODELS
  ? []
  : [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "agent",
        options: [
          { value: "agent", name: "Agent" },
          { value: "plan", name: "Plan" },
          { value: "ask", name: "Ask" },
        ],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "default[]",
        options: listedModels.map((model: { modelId: string; name: string }) => ({
          value: model.modelId,
          name: model.name,
        })),
      },
    ];
let configOptions: Record<string, unknown>[] = defaultConfigOptions;
const sessionId = "cursor-acp-fixture-session";
let currentSessionId = sessionId;
const stateDirectory = Bun.env.CURSOR_ACP_FIXTURE_STATE;
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
  let request: {
    id?: number;
    method: string;
    params: {
      sessionId?: string;
      configId?: string;
      value?: string;
      prompt?: { text: string }[];
    };
  };
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  void log(request);
  const reply = (result: unknown) => write({ jsonrpc: "2.0", id: request.id, result });
  const sessionEnvelope = () => ({
    sessionId: currentSessionId,
    modes: {
      currentModeId: "agent",
      availableModes: [
        { id: "agent", name: "Agent" },
        { id: "plan", name: "Plan" },
        { id: "ask", name: "Ask" },
      ],
    },
    models: {
      currentModelId: "default[]",
      availableModels: listedModels,
    },
    configOptions,
  });
  switch (request.method) {
    case "initialize":
      reply({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
          sessionCapabilities: { list: {} },
        },
        authMethods: [{ id: "cursor_login", name: "Cursor Login", description: "fixture auth" }],
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
            message: "Invalid params",
            data: { message: `Session "${request.params.sessionId}" not found` },
          },
        });
        break;
      }
      currentSessionId = request.params.sessionId ?? sessionId;
      // A relaunch re-reads what the earlier process recorded: the loaded session's next prompt
      // echoes the stored context, the way a real reload keeps the conversation.
      if (request.method === "session/load" && stateDirectory) {
        const stored = await Bun.file(statePath(currentSessionId))
          .text()
          .catch(() => "");
        restored = stored
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as string);
      }
      reply(sessionEnvelope());
      break;
    case "session/set_config_option": {
      if (request.params.configId === "model") {
        const valid = listedModels.some(
          (model: { modelId: string }) => model.modelId === request.params.value,
        );
        if (!valid) {
          write({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32602,
              message: "Invalid params",
              data: { message: `Invalid model value: ${request.params.value}` },
            },
          });
          break;
        }
      }
      configOptions = configOptions.map((entry: { id?: string; currentValue?: string }) =>
        entry.id === request.params.configId
          ? { ...entry, currentValue: request.params.value }
          : entry,
      );
      reply({ configOptions });
      break;
    }
    case "session/set_mode":
      reply({});
      break;
    case "session/delete":
    case "session/close":
      reply({});
      break;
    case "session/prompt": {
      const text = request.params.prompt?.[0]?.text ?? "";
      if (text === "crash") {
        // A mid-turn process death: stderr explains the exit before the child dies without a
        // prompt reply.
        console.error("cursor-agent acp: fatal internal error, aborting");
        process.exit(1);
      }
      if (Bun.env.CURSOR_ACP_FIXTURE_QUOTA) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32603,
            message: "quota exhausted",
            data: { reason: "quota", detail: "monthly quota exhausted" },
          },
        });
        break;
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
      if (Bun.env.CURSOR_ACP_FIXTURE_HANG) {
        // An accepted prompt emits work then stays live forever: only interrupt/disposal ends it.
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "working" },
        });
        break;
      }
      update({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `echo ${text}` },
      });
      reply({ stopReason: text === "refuse" ? "cancelled" : "end_turn" });
      break;
    }
    default:
      if (request.id !== undefined) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `"Method not found": ${request.method}` },
        });
      }
      break;
  }
}
