import { APP_IDENTITY_SCOPES as APP_SCOPES } from "@lrm/coforge-sdk/internal/app-scopes";
import type { AgentAppAccessState, AgentAppView } from "@lrm/coforge-sdk/agent";
import type { AppClient } from "./app-client";
import { runWithAppToken } from "./app-token-exec";
import { parseInvokeArgs } from "./app-invoke-args";
import { INPUT_MAX_BYTES, readCappedStdin } from "./action-input";
import { runInvoke, type ActionInvokeIo } from "./action-invoke";
import {
  APPROVAL_REQUIRED_EXIT_CODE,
  uncoveredScopesMessage,
  requestAppToken,
} from "./app-token-request";
import { runListActions, type AppInvokeInvocation } from "./app-actions";
import {
  APP_MANAGEMENT_SUBCOMMANDS,
  isAppManagementInvocation,
  parseAppManagementArgs,
  type AppManagementInvocation,
} from "./app-management-args";
import {
  isAppRegistrationInvocation,
  parseAppRegistrationArgs,
  type AppRegistrationInvocation,
} from "./app-registration-args";

/** `coforge app list`: the Workspace's apps, and with `all` the built-in Agent Apps too. */
export type AppListInvocation = { command: "app-list"; all?: true; json?: true };
/** `coforge app token`: run `program` with a token for the app `appKey`. */
export type AppTokenInvocation = {
  command: "app-token";
  appKey: string;
  target?: string;
  /** The Login with CoForge scopes asked for, repeatable `--scope`; none: the grant's. */
  scopes?: string[];
  program: string;
  args: string[];
  timeoutSeconds: number;
};

const APP_USAGE =
  "Usage: coforge app list [--all | --owned] [--json] | coforge app invoke <app-key> --list-actions [--action <name>] [--json] | coforge app invoke <app-key> <action> [--param key=value]... | [--data-json <object> | --data-file <path|->] [--preflight] [--idempotency-key <key>] [--target <target>] [--timeout <seconds>] [--json] | coforge app token --app <key> [--scope <scope>]... [--target <target>] [--timeout <seconds>] --exec <program> [-- <args>...] | coforge app prepare register --target <target> --name <name> [--redirect-url <url>]... [--client-key <key>] [--homepage-url <url>] [--description <text>] [--when-to-use <text>] [--category <category>] [--agent-manifest-url <url>] [--scope <scope>]... [--draft-hint <text>] | coforge app status (--card <message-id> | --client <key>) [--json] | coforge app rotate-secret --client <key> --output <new path> [--json] | coforge app update --client <key> [--name <n>] [--description <t>] [--when-to-use <t>] [--category <c>] [--homepage-url <u> | --clear-homepage-url] [--redirect-url <u>]... | [--add-redirect-url <u>]... [--agent-manifest-url <u> | --clear-agent-manifest-url] [--scope <scope>]... | [--clear-scopes] [--json] | coforge app logo --client <key> --file <path> [--json] | coforge app clear-logo|delete|share-link-status|revoke-share-link|request-publish|request-unpublish --client <key> [--json] | coforge app transfer-owner --client <key> --to-agent <name> [--json] | coforge app prepare recover-owner --client <key> --to-agent <name> --target <target> [--draft-hint <text>] | coforge app share-link --client <key> [--expires-days <1-365>] [--json]";
/** How long the program may run by default; `--timeout` takes 1 to 300 seconds, as the token
 * lives five minutes. */
export const DEFAULT_APP_TOKEN_TIMEOUT_SECONDS = 60;
const MAX_APP_TOKEN_TIMEOUT_SECONDS = 300;

function invalid(message: string): never {
  throw new Error(`${message}\n${APP_USAGE}`);
}

function parseTimeout(raw: string): number {
  const seconds = /^[1-9]\d{0,2}$/.test(raw) ? Number(raw) : 0;
  if (seconds < 1 || seconds > MAX_APP_TOKEN_TIMEOUT_SECONDS)
    invalid(`--timeout takes a whole number of seconds from 1 to 300, not "${raw}"`);
  return seconds;
}

/** `coforge app list|invoke|token ...`, without the leading `app`. Everything after `--` is the
 * program's own. */
export function parseAppArgs(
  args: readonly string[],
):
  | AppListInvocation
  | AppInvokeInvocation
  | AppTokenInvocation
  | AppRegistrationInvocation
  | AppManagementInvocation {
  const [subcommand, ...rest] = args;
  const separator = rest.indexOf("--");
  const options = separator === -1 ? rest : rest.slice(0, separator);
  const programArgs = separator === -1 ? [] : rest.slice(separator + 1);
  if (subcommand === "list") {
    const invocation: AppListInvocation = { command: "app-list" };
    let owned = false;
    for (const option of rest)
      if (option === "--all") invocation.all = true;
      else if (option === "--json") invocation.json = true;
      else if (option === "--owned") owned = true;
      else invalid(`Unexpected argument ${option}`);
    if (!owned) return invocation;
    if (invocation.all) invalid("--owned and --all cannot be combined");
    return { command: "app-list-owned", json: invocation.json === true };
  }
  if (subcommand === "prepare" && rest[0] === "recover-owner")
    return parseAppManagementArgs("prepare-recover-owner", rest.slice(1), invalid);
  if (subcommand && APP_MANAGEMENT_SUBCOMMANDS.includes(subcommand))
    return parseAppManagementArgs(subcommand, rest, invalid);
  if (subcommand === "prepare" || subcommand === "status" || subcommand === "rotate-secret")
    return parseAppRegistrationArgs(subcommand, rest, invalid);
  if (subcommand === "invoke") return parseInvokeArgs(rest, invalid, parseTimeout);
  if (subcommand !== "token") invalid(`Unknown app command ${subcommand ?? ""}`.trim());
  const values: Record<string, string> = {};
  const scopes: string[] = [];
  for (let index = 0; index < options.length; index += 2) {
    const [option, value] = [options[index]!, options[index + 1]];
    if (!["--app", "--target", "--timeout", "--exec", "--scope"].includes(option))
      invalid(`Unexpected argument ${option}`);
    if (value === undefined || value === "") invalid(`${option} needs a value`);
    if (option !== "--scope") values[option] = value;
    else if (!(APP_SCOPES as readonly string[]).includes(value))
      invalid(`--scope takes one of ${APP_SCOPES.join(", ")}, not "${value}"`);
    else if (scopes.includes(value)) invalid(`--scope ${value} is given twice`);
    else scopes.push(value);
  }
  const appKey = values["--app"]?.trim();
  if (!appKey) invalid("--app is required");
  const program = values["--exec"];
  if (!program) invalid("--exec is required: the program to run with the token");
  return {
    command: "app-token",
    appKey,
    ...(values["--target"] ? { target: values["--target"] } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
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
    "Call an app with: coforge app token --app <key> [--scope <scope>]... [--target <target>] --exec <program> -- <args>",
  );
  return blocks.join("\n\n");
}

/** What `app` commands need from the CLI; the optional fields are the `app invoke` seams tests
 * inject. */
export type AppCommandIo = {
  stdout(chunk: string | Uint8Array): void;
  stderr(chunk: string | Uint8Array): void;
  /** The CLI's environment; the program gets only a few names of it. */
  env: Record<string, string | undefined>;
} & Partial<Omit<ActionInvokeIo, "stdout">>;

/** An input file's text, at most 1 MiB. */
async function readInputFile(path: string): Promise<string> {
  const file = Bun.file(path);
  if (file.size > INPUT_MAX_BYTES) throw new Error("larger than 1 MiB");
  return file.text();
}

/** Runs `coforge app list|invoke|token` and resolves to the CLI's exit code. The token is handed to the
 * program on file descriptor 3 and never printed. */
export async function runAppCommand(
  invocation:
    | AppListInvocation
    | AppInvokeInvocation
    | AppTokenInvocation
    | AppRegistrationInvocation
    | AppManagementInvocation,
  client: AppClient,
  io: AppCommandIo,
): Promise<number> {
  if (isAppRegistrationInvocation(invocation) || isAppManagementInvocation(invocation))
    throw new Error("the register and management commands run through their own runners");
  if (invocation.command === "app-list") {
    const { apps } = await client.appList();
    const all = Boolean(invocation.all);
    const shown = all ? apps : apps.filter((app) => !app.builtIn);
    io.stdout(`${invocation.json ? JSON.stringify({ apps: shown }) : formatAppList(shown, all)}\n`);
    return 0;
  }
  if (invocation.command === "app-invoke") {
    const { apps } = await client.appList();
    const stdout = (chunk: string) => io.stdout(chunk);
    if (invocation.listActions)
      return runListActions(invocation, apps, { stdout, fetchManifest: io.fetchManifest });
    return runInvoke(invocation, apps, client, {
      stdout,
      fetchManifest: io.fetchManifest,
      fetch: io.fetch,
      requestTimeoutMs: io.requestTimeoutMs,
      readFile: io.readFile ?? readInputFile,
      readStdin: io.readStdin ?? (() => readCappedStdin()),
    });
  }
  const answer = await requestAppToken(
    client,
    invocation.appKey,
    invocation.target,
    invocation.scopes,
  );
  const uncovered = uncoveredScopesMessage(invocation.appKey, answer, invocation.scopes);
  if (uncovered) {
    io.stderr(`coforge: ${uncovered}\n`);
    return 1;
  }
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
