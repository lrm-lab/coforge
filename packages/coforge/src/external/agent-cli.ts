import { hostname, platform, release } from "node:os";
import { COFORGE_CLI_VERSION } from "../version";
import { CliError } from "../cli-error";
import { parseAgentLoginArgs, runAgentLogin } from "./login";
import { runAgentLogout, runAgentStatus } from "./profile-commands";
import { profileStore } from "./profile-store";

export const AGENT_SUBCOMMANDS = ["login", "status", "logout"] as const;

export function isAgentSubcommand(args: readonly string[]): boolean {
  return (
    args[0] === "agent" && (AGENT_SUBCOMMANDS as readonly (string | undefined)[]).includes(args[1])
  );
}

async function openBrowser(uri: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", uri]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", uri]
        : ["xdg-open", uri];
  try {
    const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
    await child.exited;
  } catch {
    // The URI is already printed; a person can open it.
  }
}

/** On a terminal, Enter opens the verification page; anywhere else nothing waits on input. */
function enterOpensBrowser(uri: string): () => void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return () => {};
  process.stdout.write("Press Enter to open the page in your browser.\n");
  const onData = () => void openBrowser(uri);
  process.stdin.once("data", onData);
  return () => {
    process.stdin.off("data", onData);
    process.stdin.pause();
  };
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
    let dispose = () => {};
    try {
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
        offerBrowser: (uri) => {
          dispose = enterOpensBrowser(uri);
        },
      });
    } finally {
      dispose();
    }
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
  throw new CliError({
    code: "INVALID_ARG",
    message: "Usage: coforge agent login|status|logout",
    retryable: false,
  });
}
