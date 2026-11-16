import { CliError } from "../cli-error";
import { probeContext } from "./agent-context";
import {
  pollDeviceToken,
  startDeviceGrant,
  type FetchLike,
  type IssuedKey,
  type MachineIdentity,
} from "./device-client";
import {
  defaultProfileSlug,
  type AgentProfile,
  type PendingLogin,
  type ProfileStore,
} from "./profile-store";
import { revokeSelf } from "./self-revoke";

export type LoginDeps = {
  store: ProfileStore;
  fetch: FetchLike;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  stdout: (text: string) => void;
  machine: MachineIdentity;
  /** Called with the verification URI and profile server URL when a terminal user may open it. */
  offerBrowser?: (verificationUri: string, serverUrl: string) => void;
};

export type LoginInvocation =
  | {
      resume: false;
      server: string;
      workspace: string;
      agent: string;
      noBrowser: boolean;
      noWait: boolean;
    }
  | { resume: true };

const LOGIN_USAGE =
  "Usage: coforge agent login --server <url> --workspace <slug> --agent <name> [--profile <slug>] [--no-browser] [--no-wait] | coforge agent login --resume [--profile <slug>]";
const MAX_CONSECUTIVE_FAILURES = 5;
const SLOW_DOWN_SECONDS = 5;

function usage(): CliError {
  return new CliError({ code: "INVALID_ARG", message: LOGIN_USAGE, retryable: false });
}

/** A server is its origin; plain HTTP is only for a machine's own loopback. */
export function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError({
      code: "INVALID_ARG",
      message: "--server must be a URL.",
      retryable: false,
    });
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new CliError({
      code: "INVALID_ARG",
      message: "--server must be an https:// URL.",
      retryable: false,
    });
  return url.origin;
}

export function parseAgentLoginArgs(args: readonly string[]): LoginInvocation {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--resume" || arg === "--no-browser" || arg === "--no-wait") flags.add(arg);
    else if (arg === "--server" || arg === "--workspace" || arg === "--agent") {
      const value = args[++index];
      if (!value || value.startsWith("--") || values.has(arg)) throw usage();
      values.set(arg, value);
    } else throw usage();
  }
  if (flags.has("--resume")) {
    if (values.size > 0 || flags.size > 1) throw usage();
    return { resume: true };
  }
  const server = values.get("--server");
  const workspace = values.get("--workspace");
  const agent = values.get("--agent");
  if (!server || !workspace || !agent) throw usage();
  return {
    resume: false,
    server: normalizeServerUrl(server),
    workspace,
    agent: agent.replace(/^@/, ""),
    noBrowser: flags.has("--no-browser"),
    noWait: flags.has("--no-wait"),
  };
}

function minutes(milliseconds: number): string {
  const count = Math.max(1, Math.ceil(milliseconds / 60_000));
  return `${count} minute${count === 1 ? "" : "s"}`;
}

function pendingLines(pending: PendingLogin, now: number): string[] {
  return [
    `Open: ${pending.verificationUri}`,
    `Code: ${pending.userCode}`,
    `Expires: ${pending.expiresAt} (in ${minutes(Date.parse(pending.expiresAt) - now)})`,
  ];
}

function rerun(slug: string): string {
  return `then run: coforge agent login --resume --profile ${slug}`;
}

function sameAgent(profile: AgentProfile, server: string, workspace: string, agent: string) {
  return (
    profile.serverUrl === server &&
    profile.workspaceSlug === workspace &&
    profile.agentName.toLowerCase() === agent.toLowerCase()
  );
}

function alreadyExists(slug: string, profile: AgentProfile): CliError {
  return new CliError({
    code: "PROFILE_ALREADY_EXISTS",
    message: `Profile "${slug}" is already bound to @${profile.agentName} in ${profile.workspaceSlug} on ${profile.serverUrl}.`,
    retryable: false,
    suggestedNextAction:
      "Pick another name with --profile, or run `coforge agent logout --profile` first.",
  });
}

async function awaitKey(deps: LoginDeps, slug: string, pending: PendingLogin): Promise<IssuedKey> {
  let interval = Math.max(1, pending.interval);
  let failures = 0;
  const expiresAt = Date.parse(pending.expiresAt);
  while (deps.now() < expiresAt) {
    await deps.sleep(interval * 1000);
    const poll = await pollDeviceToken(deps.fetch, pending.serverUrl, pending.deviceCode).catch(
      async (error: unknown) => {
        await deps.store.removePending(slug);
        throw error;
      },
    );
    if (poll.state === "authorized") return poll.key;
    if (poll.state === "slow_down") interval += SLOW_DOWN_SECONDS;
    if (poll.state === "transient") {
      if (++failures >= MAX_CONSECUTIVE_FAILURES)
        throw new CliError({
          code: "LOGIN_NETWORK_FAILED",
          message: "Lost contact with the server while waiting for approval.",
          retryable: true,
          suggestedNextAction: rerun(slug),
        });
    } else failures = 0;
  }
  await deps.store.removePending(slug);
  throw new CliError({
    code: "DEVICE_CODE_EXPIRED",
    message: "The sign-in code expired before it was approved.",
    retryable: false,
    suggestedNextAction: "Run `coforge agent login` again.",
  });
}

async function finish(
  deps: LoginDeps,
  slug: string,
  pending: PendingLogin,
  key: IssuedKey,
): Promise<void> {
  const previous = await deps.store.readProfileIgnoreCorrupt(slug);
  await deps.store.writeProfile(slug, {
    schemaVersion: 1,
    serverUrl: pending.serverUrl,
    workspaceId: key.workspaceId,
    workspaceSlug: key.workspaceSlug,
    agentId: key.agentId,
    agentName: key.agentName,
    credentialId: key.credentialId,
    apiKey: key.apiKey,
    createdAt: new Date(deps.now()).toISOString(),
  });
  await deps.store.removePending(slug);
  deps.stdout("state: authorized\n");
  deps.stdout(`Agent: @${key.agentName} in ${key.workspaceSlug}\nProfile: ${slug}\n`);
  if (previous && previous.agentId === key.agentId && previous.apiKey !== key.apiKey) {
    const outcome = await revokeSelf(deps.fetch, previous.serverUrl, previous.apiKey);
    deps.stdout(
      outcome.state === "failed"
        ? `Previous key: not revoked (${outcome.detail}); revoke it from the Agent's settings.\n`
        : `Previous key: ${outcome.state === "revoked" ? "revoked" : "already revoked"}.\n`,
    );
  }
  deps.stdout(`Use it with: coforge --profile ${slug} <command>, or COFORGE_PROFILE=${slug}\n`);
}

async function wait(deps: LoginDeps, slug: string, pending: PendingLogin): Promise<void> {
  const key = await awaitKey(deps, slug, pending);
  await finish(deps, slug, pending, key);
}

export async function runAgentLogin(
  invocation: LoginInvocation,
  profileSlug: string | undefined,
  deps: LoginDeps,
): Promise<void> {
  if (invocation.resume) return resume(profileSlug, deps);
  const slug = profileSlug ?? defaultProfileSlug(invocation.workspace, invocation.agent);
  const existing = await deps.store.readProfileIgnoreCorrupt(slug);
  if (existing) {
    if (!sameAgent(existing, invocation.server, invocation.workspace, invocation.agent))
      throw alreadyExists(slug, existing);
    const probe = await probeContext(existing, deps.fetch);
    if (probe.state === "ok" && probe.context.agent.id === existing.agentId) {
      deps.stdout(
        `state: already_logged_in\nAgent: @${existing.agentName} in ${existing.workspaceSlug}\nProfile: ${slug}\n`,
      );
      return;
    }
  }
  const grant = await startDeviceGrant(deps.fetch, invocation.server, {
    workspace: invocation.workspace,
    agent: invocation.agent,
    machine: deps.machine,
  });
  const now = deps.now();
  const pending: PendingLogin = {
    serverUrl: invocation.server,
    deviceCode: grant.deviceCode,
    userCode: grant.userCode,
    verificationUri: grant.verificationUri,
    expiresAt: new Date(now + grant.expiresIn * 1000).toISOString(),
    interval: grant.interval,
    workspace: invocation.workspace,
    agent: invocation.agent,
  };
  await deps.store.writePending(slug, pending);
  if (invocation.noWait) {
    deps.stdout(
      `state: pending_human_action\n${pendingLines(pending, now).join("\n")}\nA person must approve it; ${rerun(slug)}\n`,
    );
    return;
  }
  deps.stdout(`${pendingLines(pending, now).join("\n")}\nWaiting for approval...\n`);
  if (!invocation.noBrowser) deps.offerBrowser?.(pending.verificationUri, pending.serverUrl);
  await wait(deps, slug, pending);
}

async function resume(profileSlug: string | undefined, deps: LoginDeps): Promise<void> {
  let slug = profileSlug;
  if (slug === undefined) {
    const waiting = await deps.store.listPendingLogins();
    if (waiting.length !== 1)
      throw new CliError({
        code: waiting.length === 0 ? "LOGIN_NOT_PENDING" : "PROFILE_AMBIGUOUS",
        message:
          waiting.length === 0
            ? "No sign-in is waiting to be resumed."
            : `Several sign-ins are waiting (${waiting.join(", ")}).`,
        retryable: false,
        suggestedNextAction:
          waiting.length === 0
            ? "Run `coforge agent login --server <url> --workspace <slug> --agent <name>`."
            : "Pass --profile <slug>.",
      });
    slug = waiting[0]!;
  }
  const pending = await deps.store.readPending(slug);
  if (!pending)
    throw new CliError({
      code: "LOGIN_NOT_PENDING",
      message: `Profile "${slug}" has no sign-in waiting to be resumed.`,
      retryable: false,
      suggestedNextAction:
        "Run `coforge agent login --server <url> --workspace <slug> --agent <name>`.",
    });
  const existing = await deps.store.readProfileIgnoreCorrupt(slug);
  if (existing && !sameAgent(existing, pending.serverUrl, pending.workspace, pending.agent))
    throw alreadyExists(slug, existing);
  deps.stdout(`${pendingLines(pending, deps.now()).join("\n")}\nWaiting for approval...\n`);
  await wait(deps, slug, pending);
}
