import { hostname, platform, release } from "node:os";
import { COFORGE_CLI_VERSION } from "../version";
import { CliError } from "../cli-error";
import { parseAgentLoginArgs, runAgentLogin } from "./login";
import { parseBridgeArgs, runBridge } from "./bridge";
import { runAgentLogout, runAgentStatus } from "./profile-commands";
import { profileStore } from "./profile-store";
import { readFirstLine, readHiddenLine } from "./read-key";

export const AGENT_SUBCOMMANDS = ["login", "status", "logout", "bridge"] as const;

export function isAgentSubcommand(args: readonly string[]): boolean {
  return (
    args[0] === "agent" && (AGENT_SUBCOMMANDS as readonly (string | undefined)[]).includes(args[1])
  );
}

/** `coforge agent login|status|logout`: profile management, which never needs a profile to exist. */
export async function runAgentSubcommand(
  args: readonly string[],
  profileSlug: string | undefined,
  env: Record<string, string | undefined>,
): Promise<void> {
  const store = profileStore(env);
  const rest = args.slice(2);
  if (args[1] === "login") {
    const invocation = parseAgentLoginArgs(rest);
    await runAgentLogin(invocation, profileSlug, {
      store,
      fetch: (input, init) => fetch(input, init),
      now: () => Date.now(),
      sleep: (milliseconds) => Bun.sleep(milliseconds),
      stdout: (text) => void process.stdout.write(text),
      machine: {
        machineName: hostname(),
        hostname: hostname(),
        os: `${platform()} ${release()}`,
        clientName: `coforge-cli ${COFORGE_CLI_VERSION}`,
      },
      readKey: () =>
        process.stdin.isTTY
          ? readHiddenLine(process.stdin, (text) => void process.stderr.write(text))
          : readFirstLine(process.stdin),
    });
    return;
  }
  const deps = { store, fetch: (input: URL, init?: RequestInit) => fetch(input, init) };
  if (args[1] === "status") {
    const { output, exitCode } = await runAgentStatus(rest, profileSlug, deps);
    console.log(output);
    process.exitCode = exitCode;
    return;
  }
  if (args[1] === "logout") {
    console.log(await runAgentLogout(rest, profileSlug, deps));
    return;
  }
  if (args[1] === "bridge") {
    const options = parseBridgeArgs(rest, env);
    const stopping = new AbortController();
    const stop = () => stopping.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      process.exitCode = await runBridge(options, profileSlug, {
        ...deps,
        stdout: (text) => void process.stdout.write(text),
        stderr: (text) => void process.stderr.write(text),
        sleep: (milliseconds) => Bun.sleep(milliseconds),
        signal: stopping.signal,
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  }
  throw new CliError({
    code: "INVALID_ARG",
    message: "Usage: coforge agent login|status|logout|bridge",
    retryable: false,
  });
}
