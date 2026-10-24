import type { WorkspaceInfoResponse } from "@lrm/coforge-sdk/internal";
import type { WorkspaceInfoRuntimeContext } from "@lrm/coforge-sdk/agent";

export type WorkspaceInfoOptions = {
  agents?: boolean;
  humans?: boolean;
  projects?: boolean;
  computers?: boolean;
  full?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
};
export type WorkspaceInfoInvocation = { command: "workspace.info" } & WorkspaceInfoOptions;
/** `whoami`'s view of the `workspace_info` result. */
export type WorkspaceInfoResult = WorkspaceInfoResponse & {
  computers?: unknown[];
};

export function parseWorkspaceInfoArgs(args: readonly string[]): WorkspaceInfoInvocation {
  const result: WorkspaceInfoOptions = {};
  const flags = new Set([
    "--agents",
    "--humans",
    "--projects",
    "--computers",
    "--full",
    "--query",
    "--limit",
    "--offset",
  ]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (
      !flag ||
      !flags.has(flag) ||
      (flag !== "--agents" &&
        flag !== "--humans" &&
        flag !== "--projects" &&
        flag !== "--computers" &&
        flag !== "--full" &&
        !args[i + 1])
    )
      throw new Error(
        "Usage: coforge workspace info [--agents|--humans|--projects|--computers|--full] [--query <text>] [--limit <n>] [--offset <n>]",
      );
    if (flag === "--agents") result.agents = true;
    else if (flag === "--humans") result.humans = true;
    else if (flag === "--projects") result.projects = true;
    else if (flag === "--computers") result.computers = true;
    else if (flag === "--full") result.full = true;
    else if (flag === "--query") result.query = args[++i]!.trim() || undefined;
    else {
      const value = Number(args[++i]);
      if (
        !Number.isSafeInteger(value) ||
        (flag === "--limit" ? value < 1 || value > 100 : value < 0)
      )
        throw new Error(
          "Usage: coforge workspace info [--agents|--humans|--projects|--computers|--full] [--query <text>] [--limit <n>] [--offset <n>]",
        );
      if (flag === "--limit") result.limit = value;
      else result.offset = value;
    }
  }
  if (result.full && (result.agents || result.humans || result.projects || result.computers))
    throw new Error("Usage:");
  return { command: "workspace.info", ...result };
}

/**
 * The `runtimeContext` the CLI renders and serializes: the server's fields plus `agentWorkspacePath`,
 * which only the local Computer knows and which the CLI fills from
 * `COFORGE_CURRENT_AGENT_WORKSPACE_PATH` (mirroring `agentRuntimeContextEnvironment` in
 * `packages/daemon/src/code-agent/environment.ts`). Undefined when nothing is known at all.
 */
function cliRuntimeContext(
  runtimeContext: WorkspaceInfoRuntimeContext | undefined,
): WorkspaceInfoRuntimeContext | undefined {
  const agentWorkspacePath = Bun.env.COFORGE_CURRENT_AGENT_WORKSPACE_PATH?.trim() || undefined;
  if (!runtimeContext && !agentWorkspacePath) return undefined;
  return {
    ...runtimeContext,
    ...(agentWorkspacePath ? { agentWorkspacePath } : {}),
  };
}

/**
 * The "Current Runtime" block: authoritative, server-authored identity for this Agent process,
 * printed above the default summary and included in `--full`. Each bullet appears only when its
 * value is known; the whole block is "" when nothing is known at all.
 */
function formatCurrentRuntimeBlock(
  runtimeContext: WorkspaceInfoRuntimeContext | undefined,
): string {
  if (!runtimeContext) return "";
  const bullets: string[] = [];
  const agent = runtimeContext.agentName
    ? `@${runtimeContext.agentName}${runtimeContext.agentId ? ` (${runtimeContext.agentId})` : ""}`
    : runtimeContext.agentId;
  if (agent) bullets.push(`- Agent: ${agent}`);
  if (runtimeContext.runtime) bullets.push(`- Provider: ${runtimeContext.runtime}`);
  if (runtimeContext.model) bullets.push(`- Model: ${runtimeContext.model}`);
  if (runtimeContext.reasoning) bullets.push(`- Reasoning: ${runtimeContext.reasoning}`);
  const workspace = runtimeContext.workspaceName
    ? `${runtimeContext.workspaceName}${runtimeContext.workspaceSlug ? ` (${runtimeContext.workspaceSlug})` : ""}`
    : runtimeContext.workspaceSlug;
  if (workspace) bullets.push(`- Workspace: ${workspace}`);
  const computer = runtimeContext.computerName
    ? `${runtimeContext.computerName}${runtimeContext.computerId ? ` (${runtimeContext.computerId})` : ""}`
    : runtimeContext.computerId;
  if (computer) bullets.push(`- Computer: ${computer}`);
  if (runtimeContext.computerHostname)
    bullets.push(`- Hostname: ${runtimeContext.computerHostname}`);
  if (runtimeContext.computerOs) bullets.push(`- OS: ${runtimeContext.computerOs}`);
  if (runtimeContext.computerVersion)
    bullets.push(`- Computer version: v${runtimeContext.computerVersion}`);
  if (runtimeContext.agentWorkspacePath)
    bullets.push(`- Agent workspace: ${runtimeContext.agentWorkspacePath}`);
  if (bullets.length === 0) return "";
  return [
    "### Current Runtime",
    "Authoritative context for this Agent process. Do not infer Computer identity from hostname or cwd when this section is present.",
    ...bullets,
  ].join("\n");
}

export function formatWorkspaceInfo(
  result: WorkspaceInfoResult,
  options: WorkspaceInfoOptions,
): string {
  const section = options.full
    ? "full"
    : options.agents
      ? "agents"
      : options.humans
        ? "humans"
        : options.projects
          ? "projects"
          : "summary";
  const runtimeContext = cliRuntimeContext(result.runtimeContext);
  if (section === "summary") {
    const counts = `${result.workspace.name} (${result.workspace.slug})\nagents=${result.agents.length} humans=${result.humans.length} projects=${result.projects.length}`;
    const block = formatCurrentRuntimeBlock(runtimeContext);
    return block ? `${block}\n\n${counts}` : counts;
  }
  const match = (value: unknown) =>
    !options.query || JSON.stringify(value).toLowerCase().includes(options.query.toLowerCase());
  const page = <T>(values: T[]) =>
    values.filter(match).slice(options.offset ?? 0, (options.offset ?? 0) + (options.limit ?? 100));
  if (section === "agents")
    return (
      page(result.agents)
        .map(
          (agent) =>
            `${agent.displayName || agent.name} (@${agent.name}) status=${agent.status} role=${agent.role}`,
        )
        .join("\n") || "No workspace members."
    );
  if (section === "humans")
    return (
      page(result.humans)
        .map((human) => `${human.displayName || human.name} (@${human.name}) role=${human.role}`)
        .join("\n") || "No workspace humans."
    );
  if (section === "projects")
    return (
      page(result.projects)
        .map((p) => `${p.name} (${p.slug})${p.githubFullName ? ` github=${p.githubFullName}` : ""}`)
        .join("\n") || "No workspace projects."
    );
  return JSON.stringify(runtimeContext ? { ...result, runtimeContext } : result);
}
