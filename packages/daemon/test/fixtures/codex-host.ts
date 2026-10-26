import { readLines } from "./read-lines";

const trace = Bun.env.CODEX_HOST_TRACE!;
const environment = Object.fromEntries(
  [
    "HOME",
    "CODEX_HOME",
    "NO_COLOR",
    "FORCE_COLOR",
    "CODEX_HOST_SOURCE",
    "COFORGE_AGENT_PROXY_URL",
    "COFORGE_DAEMON_HOME",
    "COFORGE_CURRENT_AGENT_ID",
    "COFORGE_GIT_CONFIG_BASE_COUNT",
    "GIT_CONFIG_COUNT",
  ].map((key) => [key, Bun.env[key] ?? null]),
);
// Observe only the hook pair this fixture's explicit hooks-path plan owns.
const gitConfig =
  Bun.env.COFORGE_GIT_CONFIG_BASE_COUNT === "0"
    ? [
        ["GIT_CONFIG_KEY_5", Bun.env.GIT_CONFIG_KEY_5],
        ["GIT_CONFIG_VALUE_5", Bun.env.GIT_CONFIG_VALUE_5],
      ]
    : [];
if (process.argv.includes("status")) {
  await Bun.write(trace, JSON.stringify({ environment, gitConfig, argv: process.argv.slice(2) }));
  console.error("Logged in using ChatGPT");
} else {
  for await (const line of readLines(Bun.stdin.stream())) {
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize")
      await Bun.write(
        trace,
        JSON.stringify({ environment, gitConfig, initialize: request.params }),
      );
    if (request.id === undefined) continue;
    let result: unknown = {};
    if (request.method === "skills/list") result = { data: [{ cwd: process.cwd(), errors: [] }] };
    if (request.method === "thread/start") result = { thread: { id: "host-thread" } };
    if (request.method === "model/list")
      result = { data: [{ model: "host-model" }], nextCursor: null };
    if (request.method === "account/read")
      result = { account: { type: "chatgpt", email: "fixture@example.com" } };
    if (request.method === "account/rateLimits/read")
      result = {
        rateLimits: { planType: "plus", primary: { usedPercent: 25, windowDurationMins: 300 } },
      };
    if (request.method === "account/login/start")
      result = {
        loginId: "host-login",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "TEST-CODE",
      };
    console.log(JSON.stringify({ id: request.id, result }));
    if (request.method === "account/login/start")
      console.log(
        JSON.stringify({
          method: "account/login/completed",
          params: { loginId: "host-login", success: true },
        }),
      );
  }
}
