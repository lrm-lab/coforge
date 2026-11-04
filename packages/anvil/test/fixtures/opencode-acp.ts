import { appendFile, mkdir } from "node:fs/promises";
if (process.argv.includes("--version")) {
  console.log("2.1.0");
  process.exit(0);
}
const log = Bun.env.OPENCODE_ACP_FIXTURE_LOG;
if (Bun.env.OPENCODE_ACP_FIXTURE_REQUIRE_CONFIG) {
  // Launch must arrive with the instructions overlay: `OPENCODE_CONFIG_CONTENT` naming a
  // readable private instructions file, like the session profile builds.
  const raw = Bun.env.OPENCODE_CONFIG_CONTENT;
  let ok = false;
  try {
    const path = raw ? JSON.parse(raw).instructions?.[0] : undefined;
    ok = typeof path === "string" && (await Bun.file(path).text()).length > 0;
  } catch {}
  if (!ok) {
    console.error("OPENCODE_CONFIG_CONTENT missing or instructions file unreadable");
    process.exit(1);
  }
}
if (log)
  await appendFile(log, `${JSON.stringify({ configContent: Bun.env.OPENCODE_CONFIG_CONTENT })}\n`);
const defaultConfigOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "opencode/model-a",
    options: [
      { value: "opencode/model-a", name: "Model A" },
      { value: "opencode/model-b", name: "Model B" },
    ],
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "default",
    options: [{ value: "default" }, { value: "low" }, { value: "high" }],
  },
];
let configOptions = Bun.env.OPENCODE_ACP_FIXTURE_CONFIG_OPTIONS
  ? JSON.parse(Bun.env.OPENCODE_ACP_FIXTURE_CONFIG_OPTIONS)
  : defaultConfigOptions;
const sessionId = "oc-acp-fixture-session";
let currentSessionId = sessionId;
const deletedSessions: string[] = [];
// OPENCODE_ACP_FIXTURE_STATE keeps per-session prompts across processes, the way a killed and
// relaunched `opencode acp` still sees the session it loaded.
const stateDirectory = Bun.env.OPENCODE_ACP_FIXTURE_STATE;
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
        agentCapabilities: { loadSession: true },
        authMethods: [],
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
            message: `Invalid params: session not found: ${request.params.sessionId}`,
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
      reply({ sessionId: currentSessionId, configOptions });
      break;
    case "session/set_config_option": {
      configOptions = configOptions.map((entry: { id?: string; currentValue?: string }) =>
        entry.id === request.params.configId
          ? { ...entry, currentValue: request.params.value }
          : entry,
      );
      // The `thought_level` effort select only appears after a model applies — its values come
      // from OPENCODE_ACP_FIXTURE_EFFORTS keyed by model id, or a shared default list.
      if (request.params.configId === "model") {
        const perModel = Bun.env.OPENCODE_ACP_FIXTURE_EFFORTS
          ? JSON.parse(Bun.env.OPENCODE_ACP_FIXTURE_EFFORTS)
          : {};
        const values =
          perModel[request.params.value] ??
          (Bun.env.OPENCODE_ACP_FIXTURE_NO_EFFORTS ? [] : ["default", "low", "high"]);
        configOptions = configOptions.filter(
          (entry: { id?: string; category?: string }) => entry.category !== "thought_level",
        );
        configOptions.push({
          id: "effort",
          name: "Effort",
          category: "thought_level",
          type: "select",
          currentValue: "default",
          options: values.map((value: string) => ({ value })),
        });
      }
      reply({ configOptions });
      break;
    }
    case "session/delete":
    case "session/close":
      deletedSessions.push(request.params.sessionId);
      reply({});
      break;
    case "session/set_mode":
      reply({});
      break;
    case "session/prompt": {
      const text = request.params.prompt[0].text;
      if (text === "crash") {
        // A mid-turn process death: stderr explains the exit before the child dies without a
        // prompt reply.
        console.error("opencode acp: fatal internal error, aborting");
        process.exit(1);
      }
      if (Bun.env.OPENCODE_ACP_FIXTURE_QUOTA) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32603,
            message: "provider.quota (HTTP 429): Rate limit exceeded. Please try again later.",
          },
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
      if (Bun.env.OPENCODE_ACP_FIXTURE_HANG) {
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
      write({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
}
