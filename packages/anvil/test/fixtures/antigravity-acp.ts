import { appendFile, readFile, writeFile } from "node:fs/promises";
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
// The real server keeps credentials on disk — the fixture's state file is their stand-in, so a
// `logout` in one process is visible to the next status read's fresh `agy acp`.
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
  // `agy acp --help` — NO_LOGIN_FLAG leaves --login out, standing in for an agy that predates it.
  const flags = Bun.env.AGY_ACP_FIXTURE_NO_LOGIN_FLAG
    ? ""
    : "  --login                           Log in with Google interactively, then exit (ACP terminal auth)\n";
  console.log(`Usage: agy acp [flags]\n\nFlags:\n${flags}`);
  process.exit(0);
}
if (process.argv.includes("--login")) {
  // `agy acp --login` — the headless terminal auth flow: print the link, take the paste on
  // stdin, and persist the sign-in the way the ACP process's state file already does.
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
      // One re-prompt, then the process gives up — the adapter must read the non-zero exit
      // as a rejected sign-in rather than waiting for another paste.
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
        authMethods: [{ id: "oauth-personal" }, { id: "oauth-business" }],
      });
      break;
    case "authenticate":
      if (Bun.env.AGY_ACP_FIXTURE_AUTH_HANG) {
        // A sign-in that never completes: only disposal or a deadline ends it.
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
      // LOGOUT_NOOP: the server acknowledges the call but the account stays signed in — the
      // adapter must report `still_logged_in` instead of claiming a sign-out.
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
