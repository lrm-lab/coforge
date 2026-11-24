import { readdir } from "node:fs/promises";
import { join } from "node:path";

if (process.argv.includes("--version")) {
  process.stdout.write("kiro-cli 2.21.2\n");
  process.exit(0);
}

const sid = "sess-fixture-kiro-usage";
const agent = (await readdir(join(process.cwd(), ".kiro/agents")))
  .find((name) => name.startsWith("coforge-runtime-"))!
  .replace(/\.json$/, "");

const write = (message: object) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
const result = (id: unknown, value: unknown) => write({ id, result: value });
const update = (value: object) =>
  write({ method: "session/update", params: { sessionId: sid, update: value } });

const configOptions = (mode: string) => [
  {
    id: "mode",
    name: "Mode",
    type: "select",
    currentValue: mode,
    options: [{ value: agent, name: agent }],
  },
];

let admissions = 0;

for await (const line of console) {
  const request = JSON.parse(line) as {
    id?: unknown;
    method?: string;
    params?: Record<string, unknown>;
  };
  switch (request.method) {
    case "initialize":
      result(request.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, _meta: { kiro: { replayMarking: true } } },
      });
      break;
    case "session/new":
      result(request.id, { sessionId: sid, configOptions: configOptions("vibe") });
      break;
    case "session/set_config_option":
      result(request.id, { configOptions: configOptions(agent) });
      break;
    case "session/prompt": {
      const text = JSON.stringify(request.params ?? {});
      update({
        sessionUpdate: "session_info_update",
        _meta: { kiro: { kind: "user_message_id_assigned", userMessageId: `msg-${++admissions}` } },
      });
      if (text.includes("turn-with-acp-usage")) {
        result(request.id, {
          stopReason: "end_turn",
          usage: { inputTokens: 900, cachedReadTokens: 400, outputTokens: 120, totalTokens: 1_020 },
        });
      } else {
        update({ sessionUpdate: "usage_update", used: 100, size: 1_000 });
        result(request.id, { stopReason: "end_turn" });
      }
      break;
    }
    default:
      break;
  }
}
