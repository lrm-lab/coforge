import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The credential state this fixture's `doctor` reports, flipped the way a real sign-in would. */
const directory = Bun.env.DROID_AUTH_FIXTURE_STATE!;
mkdirSync(directory, { recursive: true });
const statePath = join(directory, "state.json");
const readState = (): string => {
  try {
    return (
      (JSON.parse(readFileSync(statePath, "utf8")) as { state?: string }).state ?? "logged_out"
    );
  } catch {
    return "logged_out";
  }
};
const writeState = (state: string) => writeFileSync(statePath, JSON.stringify({ state }));

const args = process.argv.slice(2);
const write = (value: unknown) => console.log(JSON.stringify(value));

if (args.includes("--version")) {
  console.log("1.4.1");
  process.exit(0);
}

if (args.includes("doctor")) {
  const state = readState();
  const results =
    state === "logged_in"
      ? [
          {
            id: "auth.credentials",
            status: "pass",
            detail: "stored login session loaded from credential storage",
          },
          {
            id: "auth.verify",
            status: "pass",
            detail: "authenticated as probe.user@example.com via stored login session",
          },
        ]
      : state === "api_key"
        ? [
            {
              id: "auth.credentials",
              status: "pass",
              detail: "using FACTORY_API_KEY (overrides any stored login session)",
            },
            {
              id: "auth.verify",
              status: "warn",
              detail:
                "FACTORY_API_KEY validation was inconclusive because connectivity was not checked",
            },
          ]
        : [
            {
              id: "auth.credentials",
              status: "pass",
              detail: "credential storage responded; no stored login found",
            },
            {
              id: "auth.verify",
              status: "warn",
              detail: "no usable credentials found (not logged in)",
            },
          ];
  write({ generatedAt: new Date().toISOString(), ok: true, results });
  process.exit(0);
}

if (args.includes("exec")) {
  // The ACP server droid starts for `exec --output-format acp`: only `logout` is exercised.
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const request = JSON.parse(line) as { id?: number; method?: string };
      if (request.method === "initialize") {
        write({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, auth: { logout: {} } },
            agentInfo: { name: "@factory/cli", version: "1.4.1" },
            authMethods: [{ id: "device-pairing" }, { id: "factory-api-key" }],
          },
        });
      } else if (request.method === "logout") {
        writeState("logged_out");
        write({ jsonrpc: "2.0", id: request.id, result: {} });
      } else {
        write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: "Method not found" },
        });
      }
    }
  });
} else {
  // The interactive TUI: the login menu, then the device flow's sentence and code.
  console.log(
    [
      "Please login with your Factory account to continue.",
      "> Login",
      "  Sign into a Factory Private deployment",
      "  Exit",
    ].join("\n"),
  );
  setTimeout(() => {
    if (!Bun.env.DROID_AUTH_FIXTURE_NO_CODE)
      console.log(
        "If the link does not open automatically, please visit https://auth.factory.ai/device " +
          "and enter code SMBZ-WNMD to complete authentication.",
      );
    console.log("Waiting for authentication to complete...");
    const completeAfter = Number(Bun.env.DROID_AUTH_FIXTURE_COMPLETE_AFTER_MS ?? "0");
    if (completeAfter > 0)
      setTimeout(() => writeState("logged_in"), Number.isFinite(completeAfter) ? completeAfter : 0);
  }, 700);
  setInterval(() => {}, 1_000);
  process.on("SIGTERM", () => process.exit(0));
}
