import type { AgentAppAccessState, AgentAppView } from "@lrm/coforge-sdk/agent";
import type { AppClient } from "./app-client";
import { runWithAppToken } from "./app-token-exec";
import { CliError } from "./cli-error";

/** `coforge app list`: the Workspace's apps, and with `all` the built-in Agent Apps too. */
export type AppListInvocation = { command: "app-list"; all?: true; json?: true };
/** `coforge app token`: run `program` with a token for the app `appKey`. */
export type AppTokenInvocation = {
  command: "app-token";
  appKey: string;
  target?: string;
  program: string;
  args: string[];
  timeoutSeconds: number;
};

const APP_USAGE =
  "Usage: coforge app list [--all] [--json] | coforge app token --app <key> [--target <target>] [--timeout <seconds>] --exec <program> [-- <args>...]";
/** How long the program may run by default; `--timeout` takes 1 to 300 seconds, as the token
 * lives five minutes. */
export const DEFAULT_APP_TOKEN_TIMEOUT_SECONDS = 60;
const MAX_APP_TOKEN_TIMEOUT_SECONDS = 300;
/** Exit status when the app needs a person's approval first: nothing was run. */
const APPROVAL_REQUIRED_EXIT_CODE = 2;

function invalid(message: string): never {
  throw new Error(`${message}\n${APP_USAGE}`);
}

function parseTimeout(raw: string): number {
  const seconds = /^[1-9]\d{0,2}$/.test(raw) ? Number(raw) : 0;
  if (seconds < 1 || seconds > MAX_APP_TOKEN_TIMEOUT_SECONDS)
    invalid(`--timeout takes a whole number of seconds from 1 to 300, not "${raw}"`);
  return seconds;
}

/** `coforge app list|token ...`, without the leading `app`. Everything after `--` is the
 * program's own. */
export function parseAppArgs(args: readonly string[]): AppListInvocation | AppTokenInvocation {
  const [subcommand, ...rest] = args;
  const separator = rest.indexOf("--");
  const options = separator === -1 ? rest : rest.slice(0, separator);
  const programArgs = separator === -1 ? [] : rest.slice(separator + 1);
  if (subcommand === "list") {
    const invocation: AppListInvocation = { command: "app-list" };
    for (const option of rest)
      if (option === "--all") invocation.all = true;
      else if (option === "--json") invocation.json = true;
      else invalid(`Unexpected argument ${option}`);
    return invocation;
  }
  if (subcommand !== "token") invalid(`Unknown app command ${subcommand ?? ""}`.trim());
  const values: Record<string, string> = {};
  for (let index = 0; index < options.length; index += 2) {
    const [option, value] = [options[index]!, options[index + 1]];
    if (!["--app", "--target", "--timeout", "--exec"].includes(option))
      invalid(`Unexpected argument ${option}`);
    if (value === undefined || value === "") invalid(`${option} needs a value`);
    values[option] = value;
  }
  const appKey = values["--app"]?.trim();
  if (!appKey) invalid("--app is required");
  const program = values["--exec"];
  if (!program) invalid("--exec is required: the program to run with the token");
  return {
    command: "app-token",
    appKey,
    ...(values["--target"] ? { target: values["--target"] } : {}),
    program,
    args: programArgs,
    timeoutSeconds: values["--timeout"]
      ? parseTimeout(values["--timeout"])
      : DEFAULT_APP_TOKEN_TIMEOUT_SECONDS,
  };
}

const ACCESS: Record<AgentAppAccessState, string> = {
  granted: "granted",
  automatic: "granted on first use",
  needs_approval: "needs a person's approval",
  pending_approval: "waiting for a person's approval",
};

/** One block per app shown (built-in ones only with `all`): its key and name, when to use it,
 * what it is, and your access. */
function formatAppList(shown: readonly AgentAppView[], all: boolean): string {
  if (shown.length === 0)
    return "No apps are installed in this Workspace. Run coforge app list --all to see the built-in ones.";
  const blocks = shown.map((app) => {
    const lines = [`${app.key} — ${app.name}${app.builtIn ? " (built in)" : ""}`];
    if (app.whenToUse) lines.push(`  When to use: ${app.whenToUse}`);
    if (app.description) lines.push(`  ${app.description.replaceAll("\n", "\n  ")}`);
    if (app.homepageUrl) lines.push(`  Homepage: ${app.homepageUrl}`);
    if (app.agentManifestUrl)
      lines.push(
        `  Agent manifest: ${app.agentManifestUrl}${app.agentManifestUrlSource === "well_known" ? " (derived from the homepage; the app may not publish one)" : ""}`,
      );
    if (app.access) lines.push(`  Access: ${ACCESS[app.access]}`);
    return lines.join("\n");
  });
  if (!all) blocks.push("Built-in apps are hidden; run coforge app list --all to include them.");
  blocks.push(
    "Call an app with: coforge app token --app <key> [--target <target>] --exec <program> -- <args>",
  );
  return blocks.join("\n\n");
}

export type AppCommandIo = {
  stdout(chunk: string | Uint8Array): void;
  stderr(chunk: string | Uint8Array): void;
  /** The CLI's environment; the program gets only a few names of it. */
  env: Record<string, string | undefined>;
};

/** Runs `coforge app list|token` and resolves to the CLI's exit code. The token is handed to the
 * program on file descriptor 3 and never printed. */
export async function runAppCommand(
  invocation: AppListInvocation | AppTokenInvocation,
  client: AppClient,
  io: AppCommandIo,
): Promise<number> {
  if (invocation.command === "app-list") {
    const { apps } = await client.appList();
    const all = Boolean(invocation.all);
    const shown = all ? apps : apps.filter((app) => !app.builtIn);
    io.stdout(`${invocation.json ? JSON.stringify({ apps: shown }) : formatAppList(shown, all)}\n`);
    return 0;
  }
  const ask = () => client.appToken(invocation.appKey, invocation.target);
  // A CONFLICT is a lost race with a concurrent use of the same app: asking once more settles it.
  const answer = await ask().catch((error: unknown) => {
    if (error instanceof CliError && error.code === "CONFLICT") return ask();
    throw error;
  });
  if (answer.status === "issued")
    return runWithAppToken({
      token: answer.access_token,
      program: invocation.program,
      args: invocation.args,
      timeoutSeconds: invocation.timeoutSeconds,
      env: io.env,
      stdout: io.stdout,
      stderr: io.stderr,
    });
  if (answer.status === "not_installed") {
    io.stderr(
      `coforge: The app ${invocation.appKey} is not installed in this Workspace, so there is no token for it. Run coforge app list to see the apps you can use.\n`,
    );
    return 1;
  }
  const who = "a Workspace owner or admin, or your creator,";
  const where = answer.actionCardMessageId
    ? `Ask ${who} to approve the card posted as message ${answer.actionCardMessageId} (short ${answer.actionCardMessageId.slice(0, 8)})${invocation.target ? ` in ${invocation.target}` : ""}, then run this command again.`
    : `Run this command again with --target <#channel or @person> to post an approval card there, or ask ${who} to approve it in your Apps settings; then run it again.`;
  io.stderr(
    `coforge: Using ${invocation.appKey} needs a person's approval (request ${answer.requestId}); nothing was run. ${where}\n`,
  );
  return APPROVAL_REQUIRED_EXIT_CODE;
}
