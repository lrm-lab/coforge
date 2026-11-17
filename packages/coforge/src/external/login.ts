import { CliError } from "../cli-error";
import { isExternalCredential } from "../agent-credential";
import { probeContext } from "./agent-context";
import {
  pollDeviceToken,
  startDeviceGrant,
  type FetchLike,
  type IssuedKey,
  type MachineIdentity,
} from "./device-client";
import { isLoopbackHost } from "./loopback";
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
  readKey: () => Promise<string>;
};

export type LoginInvocation =
  | { mode: "paste"; server: string; agent: string }
  | { mode: "start"; server: string; workspace: string; agent: string }
  | { mode: "wait" };

const LOGIN_USAGE =
  "Usage: coforge agent login --server <url> --agent <id-or-name> [--profile <slug>] | coforge agent login start --server <url> --workspace <slug> --agent <name> [--profile <slug>] | coforge agent login wait [--profile <slug>]";
const MAX_CONSECUTIVE_FAILURES = 5;
const SLOW_DOWN_SECONDS = 5;

function usage(): CliError {
  return new CliError({ code: "INVALID_ARG", message: LOGIN_USAGE, retryable: false });
}

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
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname)))
    throw new CliError({
      code: "INVALID_ARG",
      message: "--server must be an https:// URL.",
      retryable: false,
    });
  return url.origin;
}

function parseValues(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!allowed.includes(arg)) throw usage();
    const value = args[++index];
    if (!value || value.startsWith("--") || values.has(arg)) throw usage();
    values.set(arg, value);
  }
  return values;
}

function loginTarget(server: string, agent: string) {
  return { server: normalizeServerUrl(server), agent: agent.replace(/^@/, "") };
}

export function parseAgentLoginArgs(args: readonly string[]): LoginInvocation {
  if (args[0] === "wait") {
    if (args.length > 1) throw usage();
    return { mode: "wait" };
  }
  if (args[0] === "start") {
    const values = parseValues(args.slice(1), ["--server", "--workspace", "--agent"]);
    const server = values.get("--server");
    const workspace = values.get("--workspace");
    const agent = values.get("--agent");
    if (!server || !workspace || !agent) throw usage();
    return { mode: "start", workspace, ...loginTarget(server, agent) };
  }
  const values = parseValues(args, ["--server", "--agent"]);
  const server = values.get("--server");
  const agent = values.get("--agent");
  if (!server || !agent) throw usage();
  return { mode: "paste", ...loginTarget(server, agent) };
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
  return `then run: coforge agent login wait --profile ${slug}`;
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
    suggestedNextAction: "Run `coforge agent login start` again.",
  });
}

type SavedKey = Omit<AgentProfile, "schemaVersion" | "createdAt">;

async function saveKey(deps: LoginDeps, slug: string, key: SavedKey): Promise<void> {
  const previous = await deps.store.readProfileIgnoreCorrupt(slug);
  await deps.store.writeProfile(slug, {
    schemaVersion: 1,
    ...key,
    createdAt: new Date(deps.now()).toISOString(),
  });
  deps.stdout("state: authorized\n");
  deps.stdout(`Agent: @${key.agentName} in ${key.workspaceSlug}\nProfile: ${slug}\n`);
  if (previous && previous.agentId === key.agentId && previous.apiKey !== key.apiKey) {
    const outcome = await revokeSelf(deps.fetch, previous.serverUrl, previous.apiKey);
    deps.stdout(
      outcome.state === "failed"
        ? `Previous key: not revoked (${outcome.detail}); revoke credential ${previous.credentialId} from the Agent's settings.\n`
        : `Previous key: ${outcome.state === "revoked" ? "revoked" : "already revoked"}.\n`,
    );
  }
  deps.stdout(`Use it with: coforge --profile ${slug} <command>, or COFORGE_PROFILE=${slug}\n`);
}

async function finish(
  deps: LoginDeps,
  slug: string,
  pending: PendingLogin,
  key: IssuedKey,
): Promise<void> {
  await saveKey(deps, slug, { serverUrl: pending.serverUrl, ...key });
  await deps.store.removePending(slug);
}

function invalidKey(message: string): CliError {
  return new CliError({
    code: "EXTERNAL_KEY_INVALID",
    message,
    retryable: false,
    suggestedNextAction: "Create a new credential on the Agent's page and run login again.",
  });
}

async function pasteLogin(
  invocation: Extract<LoginInvocation, { mode: "paste" }>,
  profileSlug: string | undefined,
  deps: LoginDeps,
): Promise<void> {
  const apiKey = (await deps.readKey()).trim();
  if (!isExternalCredential(apiKey))
    throw invalidKey("That is not an external Agent key (sk_ext_...).");
  const probe = await probeContext({ serverUrl: invocation.server, apiKey }, deps.fetch);
  if (probe.state === "unauthorized")
    throw invalidKey("The server rejected this key; it was revoked, replaced or mistyped.");
  if (probe.state === "unreachable")
    throw new CliError({
      code: "LOGIN_NETWORK_FAILED",
      message: `Could not verify the key with ${invocation.server} (${probe.detail}).`,
      retryable: true,
    });
  const { agent, workspace, credential } = probe.context;
  const wanted = invocation.agent.toLowerCase();
  if (!agent.external || !credential)
    throw invalidKey("This key does not belong to an external Agent.");
  if (agent.id.toLowerCase() !== wanted && agent.name.toLowerCase() !== wanted)
    throw new CliError({
      code: "AGENT_MISMATCH",
      message: `This key belongs to @${agent.name} in ${workspace.slug}, not to ${invocation.agent}.`,
      retryable: false,
      suggestedNextAction: "Copy the key from the page of the Agent you named with --agent.",
    });
  const slug = profileSlug ?? defaultProfileSlug(workspace.slug, agent.name);
  const existing = await deps.store.readProfileIgnoreCorrupt(slug);
  if (existing && !(existing.serverUrl === invocation.server && existing.agentId === agent.id))
    throw alreadyExists(slug, existing);
  await saveKey(deps, slug, {
    serverUrl: invocation.server,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    agentId: agent.id,
    agentName: agent.name,
    credentialId: credential.id,
    apiKey,
  });
}

export async function runAgentLogin(
  invocation: LoginInvocation,
  profileSlug: string | undefined,
  deps: LoginDeps,
): Promise<void> {
  if (invocation.mode === "paste") return pasteLogin(invocation, profileSlug, deps);
  if (invocation.mode === "wait") return waitForPending(profileSlug, deps);
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
  deps.stdout(
    `state: pending_human_action\n${pendingLines(pending, now).join("\n")}\nA person must approve it; ${rerun(slug)}\n`,
  );
}

async function waitForPending(profileSlug: string | undefined, deps: LoginDeps): Promise<void> {
  let slug = profileSlug;
  if (slug === undefined) {
    const waiting = await deps.store.listPendingLogins();
    if (waiting.length !== 1)
      throw new CliError({
        code: waiting.length === 0 ? "LOGIN_NOT_PENDING" : "PROFILE_AMBIGUOUS",
        message:
          waiting.length === 0
            ? "No sign-in is waiting for approval."
            : `Several sign-ins are waiting (${waiting.join(", ")}).`,
        retryable: false,
        suggestedNextAction:
          waiting.length === 0
            ? "Run `coforge agent login start --server <url> --workspace <slug> --agent <name>`."
            : "Pass --profile <slug>.",
      });
    slug = waiting[0]!;
  }
  const pending = await deps.store.readPending(slug);
  if (!pending)
    throw new CliError({
      code: "LOGIN_NOT_PENDING",
      message: `Profile "${slug}" has no sign-in waiting for approval.`,
      retryable: false,
      suggestedNextAction:
        "Run `coforge agent login start --server <url> --workspace <slug> --agent <name>`.",
    });
  const existing = await deps.store.readProfileIgnoreCorrupt(slug);
  if (existing && !sameAgent(existing, pending.serverUrl, pending.workspace, pending.agent))
    throw alreadyExists(slug, existing);
  deps.stdout(`${pendingLines(pending, deps.now()).join("\n")}\nWaiting for approval...\n`);
  await finish(deps, slug, pending, await awaitKey(deps, slug, pending));
}
