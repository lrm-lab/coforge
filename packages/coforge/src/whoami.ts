import type { AgentProfileShowResponse } from "@lrm/coforge-sdk/agent";
import { CliError } from "#src/cli-error";

export type WhoamiInvocation = { command: "whoami"; json?: boolean };

const WHOAMI_USAGE = "Usage: coforge whoami [--json]";

export function parseWhoamiArgs(args: readonly string[]): WhoamiInvocation {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else throw new Error(WHOAMI_USAGE);
  }
  return { command: "whoami", ...(json ? { json: true } : {}) };
}

export type WhoamiResult = {
  agentId?: string;
  agentName?: string;
  workspaceId?: string;
  workspaceSlug?: string;
  workspaceName?: string;
  computerId?: string;
  computerName?: string;
  computerHostname?: string;
  agentWorkspacePath?: string;
  proxyUrl?: string;
  /** CoForge has only daemon-spawned Agents today (no self-hosted Agent client), so this is
   * always `"daemon-managed"`; the field exists so a future client kind has somewhere to report. */
  clientMode: "daemon-managed";
  credential: {
    source: "agent-context-env" | "none";
    present: boolean;
    /** First 4 characters (the fixed `sfp_` prefix) plus an ellipsis; never the token value. */
    redacted?: string;
  };
  /** What the server says about this credential; absent when no server check was made. */
  serverConfirmed?: boolean;
  server?: { agent: { id: string; name: string; displayName: string; role: string | null } };
  serverError?: string;
  /** The refusal's code when the server answered but refused (for example a rejected credential). */
  serverErrorCode?: string;
};

function trimmedEnv(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/**
 * What `coforge whoami` answers locally — "what identity and endpoint would my next command use" —
 * read only from the process environment the Daemon already set for this Agent process
 * (`code-agent/environment.ts`); `confirmWhoami` then asks the server whether it agrees.
 * `COFORGE_DAEMON_SOCKET` is always set to `""` for an Agent launch (`daemon-runtime/runtime.ts`),
 * so it carries no information and is not reported here.
 */
function buildWhoamiResult(): WhoamiResult {
  const context = trimmedEnv(Bun.env.COFORGE_AGENT_CONTEXT);
  return {
    agentId: trimmedEnv(Bun.env.COFORGE_CURRENT_AGENT_ID),
    agentName: trimmedEnv(Bun.env.COFORGE_CURRENT_AGENT_NAME),
    workspaceId: trimmedEnv(Bun.env.COFORGE_CURRENT_WORKSPACE_ID),
    workspaceSlug: trimmedEnv(Bun.env.COFORGE_CURRENT_WORKSPACE_SLUG),
    workspaceName: trimmedEnv(Bun.env.COFORGE_CURRENT_WORKSPACE_NAME),
    computerId: trimmedEnv(Bun.env.COFORGE_CURRENT_COMPUTER_ID),
    computerName: trimmedEnv(Bun.env.COFORGE_CURRENT_COMPUTER_NAME),
    computerHostname: trimmedEnv(Bun.env.COFORGE_CURRENT_COMPUTER_HOSTNAME),
    agentWorkspacePath: trimmedEnv(Bun.env.COFORGE_CURRENT_AGENT_WORKSPACE_PATH),
    proxyUrl: trimmedEnv(Bun.env.COFORGE_AGENT_PROXY_URL),
    clientMode: "daemon-managed",
    credential: {
      source: context ? "agent-context-env" : "none",
      present: Boolean(context),
      ...(context ? { redacted: `${context.slice(0, 4)}…` } : {}),
    },
  };
}

function formatWhoami(result: WhoamiResult): string {
  const lines = ["## Who am I", ""];
  if (result.agentId) lines.push(`Agent ID: ${result.agentId}`);
  if (result.agentName) lines.push(`Agent name: @${result.agentName}`);
  if (result.workspaceId) lines.push(`Workspace ID: ${result.workspaceId}`);
  if (result.workspaceSlug) lines.push(`Workspace slug: ${result.workspaceSlug}`);
  if (result.workspaceName) lines.push(`Workspace name: ${result.workspaceName}`);
  if (result.computerId) lines.push(`Computer ID: ${result.computerId}`);
  if (result.computerName) lines.push(`Computer name: ${result.computerName}`);
  if (result.computerHostname) lines.push(`Computer hostname: ${result.computerHostname}`);
  if (result.agentWorkspacePath) lines.push(`Agent workspace: ${result.agentWorkspacePath}`);
  if (result.proxyUrl) lines.push(`Agent proxy: ${result.proxyUrl}`);
  lines.push(`Client mode: ${result.clientMode}`);
  lines.push(
    `Credential: source=${result.credential.source} present=${result.credential.present ? "yes" : "no"}` +
      (result.credential.redacted ? ` redacted=${result.credential.redacted}` : ""),
  );
  if (result.serverConfirmed === true && result.server) {
    const { name, role } = result.server.agent;
    lines.push(`Server: confirmed @${name}${role ? ` (${role})` : ""}`);
  } else if (result.serverConfirmed === false) lines.push("Server: unconfirmed");
  return lines.join("\n");
}

/**
 * Asks the server whose credential this is, through the Agent's own `profile show`, and returns
 * the result with the answer attached. A server that cannot be reached leaves the local context
 * marked unconfirmed; one that names a different Agent than the environment is an
 * `IDENTITY_MISMATCH`.
 */
async function confirmWhoami(
  local: WhoamiResult,
  profileShow: (() => Promise<AgentProfileShowResponse>) | undefined,
): Promise<WhoamiResult> {
  if (!profileShow) return local;
  let profile: AgentProfileShowResponse["profile"];
  try {
    profile = (await profileShow()).profile;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ...local,
      serverConfirmed: false,
      ...(error instanceof CliError ? { serverErrorCode: error.code } : {}),
      serverError: `Could not confirm identity with the server: ${reason}. Any local context printed is unconfirmed.`,
    };
  }
  if (local.agentId && local.agentId !== profile.id)
    throw new CliError({
      code: "IDENTITY_MISMATCH",
      message: `The server says this credential belongs to agent ${profile.id}, not the locally configured ${local.agentId}.`,
      retryable: false,
    });
  const { id, name, displayName, role } = profile;
  return { ...local, serverConfirmed: true, server: { agent: { id, name, displayName, role } } };
}

/**
 * `coforge whoami`: the local context with the server's answer, as text or `{ ok, data }` JSON.
 * When the server could not confirm it, the same output still goes to stdout but the command
 * fails with the reason, so a script never takes unconfirmed context for confirmed.
 */
export async function runWhoami(
  profileShow: (() => Promise<AgentProfileShowResponse>) | undefined,
  json: boolean,
): Promise<string> {
  const result = await confirmWhoami(buildWhoamiResult(), profileShow);
  const unconfirmed = result.serverConfirmed === false;
  const output = json ? JSON.stringify({ ok: !unconfirmed, data: result }) : formatWhoami(result);
  if (!unconfirmed) return output;
  throw new CliError({
    code: result.serverErrorCode ?? "WHOAMI_FAILED",
    message: result.serverError ?? "The server did not confirm this identity.",
    retryable: false,
    stdoutText: output,
  });
}
