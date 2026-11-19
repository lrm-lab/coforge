import { appendFile, readFile, writeFile } from "node:fs/promises";
if (process.argv.includes("--version")) {
  console.log("1.5.10");
  process.exit(0);
}
for (const name of ["SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY"]) {
  if (Bun.env[name] !== undefined) {
    console.error(`${name} leaked into agy`);
    process.exit(1);
  }
}
const log = Bun.env.AGY_ACP_FIXTURE_LOG;
const EFFORTS: Record<string, string[] | undefined> = {
  "gemini-4-carbon": ["low", "medium", "high"],
  "gemini-4-hydrogen": ["low", "medium", "high", "xhigh"],
};
let configOptions: Array<Record<string, unknown>> = Bun.env.AGY_ACP_FIXTURE_CONFIG_OPTIONS
  ? JSON.parse(Bun.env.AGY_ACP_FIXTURE_CONFIG_OPTIONS)
  : [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gemini-4-carbon",
        options: [
          { value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
          { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
          { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
        ],
      },
    ];
const withEfforts = (model: unknown) => {
  const efforts = typeof model === "string" ? EFFORTS[model] : undefined;
  const rest = configOptions.filter((entry) => entry.category !== "thought_level");
  if (!efforts) return rest;
  return [
    ...rest,
    {
      id: "thought_level",
      name: "Thinking Level",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: efforts.map((value) => ({ value, name: value })),
    },
  ];
};
configOptions = withEfforts(configOptions.find((entry) => entry.id === "model")?.currentValue);
const modes = Bun.env.AGY_ACP_FIXTURE_MODES
  ? JSON.parse(Bun.env.AGY_ACP_FIXTURE_MODES)
  : [
      { id: "default", name: "Default", description: "Ask before edits and commands." },
      { id: "accept-edits", name: "Accept edits", description: "Approve file edits." },
      { id: "auto", name: "Auto", description: "Approve edits and safe commands." },
      { id: "plan", name: "Plan", description: "Plan carefully before executing a task." },
    ];
const sessionId = "agy-acp-fixture-session";
const stateFile = Bun.env.AGY_ACP_FIXTURE_STATE;
let signedIn = Bun.env.AGY_ACP_FIXTURE_SIGNED_OUT !== "1";
if (stateFile) {
  try {
    signedIn = (await readFile(stateFile, "utf8")).trim() === "1";
  } catch {}
}
const persistSignedIn = async () => {
  if (stateFile) await writeFile(stateFile, signedIn ? "1" : "0");
};
if (process.argv.includes("--help")) {
  const flags = Bun.env.AGY_ACP_FIXTURE_NO_LOGIN_FLAG
    ? ""
    : "  --login                           Log in with Google interactively, then exit (ACP terminal auth)\n";
  console.log(`Usage: agy acp [flags]\n\nFlags:\n${flags}`);
  process.exit(0);
}
if (process.argv.includes("--login")) {
  if (Bun.env.AGY_ACP_FIXTURE_LOGIN_CRASH) {
    console.error("fixture crash: no usable display or browser");
    process.exit(1);
  }
  const url =
    Bun.env.AGY_ACP_FIXTURE_LOGIN_URL ??
    "https://accounts.google.com/o/oauth2/auth?client_id=fixture&state=s";
  if (!Bun.env.AGY_ACP_FIXTURE_LOGIN_NO_URL)
    console.log(`Open this link in a browser to log in with Google:\n\n  ${url}\n`);
  const prompt = () =>
    console.log(
      "Then paste the authorization code, or the full URL of the page you land on, and press Enter:",
    );
  prompt();
  if (Bun.env.AGY_ACP_FIXTURE_LOGIN_HANG) await new Promise(() => {});
  let rejects = 0;
  for await (const line of console) {
    const code = line.trim();
    if (!code) {
      console.log("login cancelled: no authorization code was entered");
      process.exit(1);
    }
    if (Bun.env.AGY_ACP_FIXTURE_LOGIN_REJECT && code !== "good-code") {
      rejects += 1;
      if (rejects >= 2) {
        console.log("login failed: too many rejected authorization codes");
        process.exit(1);
      }
      console.log("login failed: authorization code was not accepted");
      prompt();
      continue;
    }
    signedIn = true;
    await persistSignedIn();
    console.log("login successful");
    process.exit(0);
  }
  console.log("login cancelled: no authorization code was entered");
  process.exit(1);
}
let currentSessionId = sessionId;
const write = (value: unknown) => console.log(JSON.stringify(value));
const update = (value: unknown) =>
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: currentSessionId, update: value },
  });
let prompts = 0;
let heldReply: (() => void) | undefined;
let cancelHeld: (() => void) | undefined;
for await (const line of console) {
  const request = JSON.parse(line);
  if (log) await appendFile(log, `${JSON.stringify(request)}\n`);
  if (!request.method) continue;
  const reply = (result: unknown) => write({ jsonrpc: "2.0", id: request.id, result });
  const fail = (code: number, message: string) =>
    write({ jsonrpc: "2.0", id: request.id, error: { code, message } });
  switch (request.method) {
    case "session/cancel":
      cancelHeld?.();
      break;
    case "initialize":
      reply({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          _meta: { antigravity: { systemPrompt: { append: true } } },
        },
        authMethods: [{ id: "oauth-personal" }, { id: "oauth-business" }],
      });
      break;
    case "authenticate":
      if (Bun.env.AGY_ACP_FIXTURE_AUTH_HANG) {
        heldReply = () => {};
        break;
      }
      if (Bun.env.AGY_ACP_FIXTURE_AUTH_CANCEL) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32800, message: "Sign-in was cancelled." },
        });
        break;
      }
      signedIn = true;
      await persistSignedIn();
      reply({});
      break;
    case "logout":
      if (!Bun.env.AGY_ACP_FIXTURE_LOGOUT_NOOP) {
        signedIn = false;
        await persistSignedIn();
      }
      reply({});
      break;
    case "session/close":
      reply({});
      break;
    case "session/new":
    case "session/load":
      if (!signedIn) {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32000, message: "Authentication required" },
        });
        break;
      }
      if (Bun.env.AGY_ACP_FIXTURE_NEW_HANG) {
        heldReply = () => {};
        break;
      }
      if (request.params.sessionId === "missing-session") {
        fail(-32002, "Session not found");
        break;
      }
      currentSessionId = request.params.sessionId ?? sessionId;
      reply({
        sessionId: currentSessionId,
        configOptions,
        modes: { availableModes: modes },
        _meta: {
          antigravity: { tier: { name: "Google AI Ultra", id: "g1-ultra-tier", upgradeUri: "" } },
        },
      });
      break;
    case "session/set_mode":
      reply({});
      break;
    case "session/set_config_option": {
      const { configId, value } = request.params;
      const option = configOptions.find((entry) => entry.id === configId);
      if (!option) {
        fail(-32602, `Unknown config option: ${configId}`);
        break;
      }
      const offered = (option.options as Array<{ value: string }>).some((o) => o.value === value);
      if (!offered) {
        fail(-32602, `Value ${value} is not offered for ${configId}`);
        break;
      }
      configOptions = (configId === "model" ? withEfforts(value) : configOptions).map((entry) =>
        entry.id === configId ? { ...entry, currentValue: value } : entry,
      );
      reply({ configOptions });
      break;
    }
    case "session/prompt": {
      const text = request.params.prompt[0].text;
      prompts++;
      if (text.startsWith("run:")) {
        const commandLine = text.slice("run:".length);
        const rawInput = { CommandLine: commandLine, toolSummary: "Run a command" };
        const call = { toolCallId: "t1", name: "run_command", kind: "execute", title: commandLine };
        update({ sessionUpdate: "tool_call", ...call, status: "in_progress", rawInput });
        update({ sessionUpdate: "tool_call_update", ...call, status: "completed", rawInput });
      }
      if (text === "read-file") {
        const rawInput = { Path: "/workspace/a.txt" };
        const call = { toolCallId: "t2", name: "read_file", kind: "read", title: "File a.txt" };
        update({ sessionUpdate: "tool_call", ...call, status: "in_progress", rawInput });
        update({ sessionUpdate: "tool_call_update", ...call, status: "completed", rawInput });
      }
      update({ sessionUpdate: "usage_update", used: 9000 + prompts, size: 1048576 });
      const hold = (flush: () => void) => {
        heldReply = () => {
          cancelHeld = undefined;
          flush();
        };
        cancelHeld = () => {
          cancelHeld = undefined;
          heldReply = undefined;
          reply({ stopReason: "cancelled" });
        };
      };
      if (Bun.env.AGY_ACP_FIXTURE_HANG) {
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "working" },
        });
        hold(() => {});
        break;
      }
      if (heldReply) {
        const flush = heldReply;
        heldReply = undefined;
        flush();
      }
      if (text === "held") {
        hold(() => {
          update({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "held-ok" },
          });
          reply({ stopReason: "end_turn" });
        });
        break;
      }
      if (text === "permission-after-turn") {
        reply({ stopReason: "end_turn" });
        setTimeout(() => {
          const ask = (id: string, targetSessionId: string) =>
            write({
              jsonrpc: "2.0",
              id,
              method: "session/request_permission",
              params: {
                sessionId: targetSessionId,
                toolCall: { toolCallId: `${id}-call`, title: "Run command" },
                options: [
                  { optionId: "allow", name: "Allow", kind: "allow_once" },
                  { optionId: "deny", name: "Deny", kind: "reject_once" },
                ],
              },
            });
          ask("perm-other", "another-session");
          ask("perm-own", currentSessionId);
        }, 20);
        break;
      }
      if (text === "permission-on-interrupt") {
        update({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "working" },
        });
        hold(() => {});
        cancelHeld = () => {
          cancelHeld = undefined;
          heldReply = undefined;
          write({
            jsonrpc: "2.0",
            id: "perm-interrupting",
            method: "session/request_permission",
            params: {
              sessionId: currentSessionId,
              toolCall: { toolCallId: "interrupt-call", title: "Run command" },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
              ],
            },
          });
          setTimeout(() => reply({ stopReason: "cancelled" }), 20);
        };
        break;
      }
      if (text === "slow") {
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
      const inBand = {
        "inband-error": [
          "\n⚠ INVALID_ARGUMENT (code 400): Thinking level is unsupported: THINKING_LEVEL_XHIGH\n",
        ],
        "inband-with-usage": ["⚠ INVALID_ARGUMENT (code 400): quoted by the model"],
        "inband-embedded": [
          "Here is what failed:\n",
          "⚠ INVALID_ARGUMENT (code 400): quoted\nand more text",
        ],
      }[text as string];
      if (inBand) {
        for (const chunk of inBand)
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
        reply(
          text === "inband-with-usage"
            ? { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } }
            : { stopReason: "end_turn" },
        );
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
