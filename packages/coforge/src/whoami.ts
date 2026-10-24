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
};

function trimmedEnv(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/**
 * `coforge whoami`: deliberately local — it answers "what
 * identity and endpoint would my next command use", read only from the process environment the
 * Daemon already set for this Agent process (`code-agent/environment.ts`). It never makes a
 * request. `COFORGE_DAEMON_SOCKET` is always set to `""` for an Agent launch (`daemon-runtime/
 * runtime.ts`), so it carries no information and is not reported here.
 */
export function buildWhoamiResult(): WhoamiResult {
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

export function formatWhoami(result: WhoamiResult): string {
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
  return lines.join("\n");
}
