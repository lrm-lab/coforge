import { appendFile } from "node:fs/promises";
if (process.argv.includes("--version")) {
  console.log("0.2.1-rc.2");
  process.exit(0);
}
const log = Bun.env.DSH_FIXTURE_LOG!;
const sessionId = "dsh-fixture-session";
try {
  const patchIndex = process.argv.indexOf("--patch");
  const patch = await Bun.file(process.argv[patchIndex + 1]!).json();
  for (const entry of patch.flatMap((row: { insert?: unknown[] }) => row.insert ?? [])) {
    const plugin = await import(entry.name);
    plugin.apply({ systemPrompt: { section() {} } }, entry.config);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "DSH plugin failed");
  process.exit(1);
}
const write = (value: unknown) => console.log(JSON.stringify(value));
const update = (value: unknown) =>
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
let held: unknown;
let permissionPrompt: unknown;
for await (const line of console) {
  const request = JSON.parse(line);
  await appendFile(log, `${JSON.stringify(request)}\n`);
  const reply = (result: unknown) => write({ jsonrpc: "2.0", id: request.id, result });
  if (request.id === "permission" && !request.method) {
    write({ jsonrpc: "2.0", id: permissionPrompt, result: { stopReason: "end_turn" } });
    continue;
  }
  switch (request.method) {
    case "initialize":
      reply({
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: { image: false },
          sessionCapabilities: { resume: {}, close: {} },
        },
        authMethods: [],
      });
      break;
    case "session/new":
    case "session/resume":
      reply({
        sessionId,
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: "native-model",
            options: [{ value: "native-model", name: "Native" }],
          },
        ],
      });
      break;
    case "session/set_config_option":
      reply({ configOptions: [] });
      break;
    case "session/prompt": {
      const text = request.params.prompt[0].text;
      if (text === "self-cancel") {
        reply({ stopReason: "cancelled" });
        break;
      }
      if (text === "exit-before-evidence") process.exit(0);
      if (text === "invalid-json") {
        process.stdout.write("not-json\n");
        break;
      }
      if (text === "truncated") {
        reply({ stopReason: "max_tokens" });
        break;
      }
      if (text === "model-failed") {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32603,
            message: "Internal error: turn failed",
            data: { detail: "native model failure" },
          },
        });
        break;
      }
      if (text === "refuse") {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32602, message: "prompt was not queued" },
        });
        break;
      }
      if (text === "silent-hold") {
        held = request.id;
        break;
      }
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "accepted" } });
      if (text === "hold") {
        held = request.id;
        break;
      }
      if (text === "permission") {
        permissionPrompt = request.id;
        write({
          jsonrpc: "2.0",
          id: "permission",
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: "shell-1", title: "bash" },
            options: [
              { optionId: "once", name: "Allow", kind: "allow_once" },
              { optionId: "always", name: "Always", kind: "allow_always" },
            ],
          },
        });
        break;
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
          result: { stopReason: request.method === "session/cancel" ? "cancelled" : "end_turn" },
        });
      held = undefined;
      break;
    case "session/close":
      reply({});
      break;
  }
}
