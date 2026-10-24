import type {
  WorkspaceInfoChannel,
  WorkspaceInfoComputer,
  WorkspaceInfoResponse,
} from "@lrm/coforge-sdk/internal";
import type { WorkspaceInfoRuntimeContext } from "@lrm/coforge-sdk/agent";
import type {
  WorkspaceInfoOptions,
  WorkspaceInfoResult,
  WorkspaceInfoSection,
} from "./workspace-info";
import { WORKSPACE_INFO_SECTIONS } from "./workspace-info";

/**
 * The `runtimeContext` the CLI renders and serializes: the server's fields plus `agentWorkspacePath`,
 * which only the local Computer knows and which the CLI fills from
 * `COFORGE_CURRENT_AGENT_WORKSPACE_PATH` (mirroring `agentRuntimeContextEnvironment` in
 * `packages/daemon/src/code-agent/environment.ts`). Undefined when nothing is known at all.
 */
export function cliRuntimeContext(
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
export function formatCurrentRuntimeBlock(
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

type Agent = WorkspaceInfoResponse["agents"][number];
type Human = WorkspaceInfoResponse["humans"][number];
type Project = WorkspaceInfoResponse["projects"][number];
type Page = { total: number; offset: number; limit: number; nextCommand?: string };

const WORKSPACE_INFO_COMMAND = "coforge workspace info";

function roleLabel(role: string | null | undefined): string {
  return role && role !== "member" ? ` (${role})` : "";
}

function agentStatusLabel(agent: Agent): string {
  const lifecycle = agent.status?.trim() || "unknown";
  const activity = agent.activity?.trim();
  if (!activity) return lifecycle;
  const detail = agent.activityDetail?.trim()
    ? `${activity}: ${agent.activityDetail.trim()}`
    : activity;
  return activity === lifecycle ? lifecycle : `${lifecycle}; ${detail}`;
}

function minuteStamp(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

export function agoLabel(at: Date, now: number): string {
  const minutes = Math.floor((now - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function channelLastPost(channel: WorkspaceInfoChannel, now: number): string | undefined {
  if (channel.lastPostAt === undefined) return undefined;
  if (channel.lastPostAt === null) return "no posts yet";
  const at = new Date(channel.lastPostAt);
  if (Number.isNaN(at.getTime())) return undefined;
  return `last post ${minuteStamp(at)} (${agoLabel(at, now)})`;
}

/** Every CoForge channel is visible to the whole Workspace, so the visibility is always `public`. */
function channelStatus(channel: WorkspaceInfoChannel, now: number, withArchived: boolean): string {
  const parts = ["public", channel.joined ? "joined" : "not joined"];
  if (channel.channelRole) parts.push(`channel role=${channel.channelRole}`);
  if (channel.channelAdminBasis) parts.push(`admin via=${channel.channelAdminBasis}`);
  parts.push(channel.muted ? "muted" : "not muted");
  if (withArchived) parts.push(channel.archived ? "archived" : "not archived");
  const lastPost = channelLastPost(channel, now);
  if (lastPost) parts.push(lastPost);
  return parts.join(", ");
}

function withDescription(line: string, description: string | undefined): string {
  const text = description?.trim();
  return text ? `${line} \u2014 ${text}` : line;
}

const channelRow = (channel: WorkspaceInfoChannel, now: number, withArchived: boolean) =>
  withDescription(
    `${channel.name} [${channelStatus(channel, now, withArchived)}]`,
    channel.description,
  );
const agentRow = (agent: Agent) =>
  withDescription(
    `@${agent.name} (${agentStatusLabel(agent)})${roleLabel(agent.role)}`,
    agent.description,
  );
const humanRow = (human: Human) =>
  withDescription(`@${human.name}${roleLabel(human.role)}`, human.description);
const projectRow = (project: Project) =>
  `${project.name} (${project.slug})${project.githubFullName ? ` github=${project.githubFullName}` : ""}`;
function computerRow(computer: WorkspaceInfoComputer): string {
  const system = [computer.platform, computer.osVersion].filter(Boolean).join(" ");
  const parts = [
    computer.status,
    ...(system ? [system] : []),
    ...(computer.computerVersion ? [`v${computer.computerVersion}`] : []),
  ];
  const line = `${computer.name} [${parts.join(", ")}]`;
  return computer.displayName && computer.displayName !== computer.name
    ? `${line} \u2014 ${computer.displayName}`
    : line;
}

function pageFooter(page: Page): string {
  const past = page.offset >= page.total;
  const start = past ? 0 : page.offset + 1;
  const end = past ? 0 : Math.min(page.offset + page.limit, page.total);
  const lines = [`\nShowing ${start}-${end} of ${page.total}.`];
  if (page.nextCommand && end < page.total) lines.push(`More: ${page.nextCommand}`);
  return `${lines.join("\n")}\n`;
}

/** The row matches when the text it is shown as contains the query, ignoring case. Raft matches
 * every string field of the row instead, which also hits ids, URLs and the role of an ordinary
 * member that the row never shows, so `--query member` would match every Agent. */
function includesQuery(text: string, query: string | undefined): boolean {
  const needle = query?.trim().toLowerCase();
  return !needle || text.toLowerCase().includes(needle);
}

const shellQuoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function nextCommand(
  section: WorkspaceInfoSection,
  options: WorkspaceInfoOptions,
  offset: number,
  limit: number,
  total: number,
): string | undefined {
  const nextOffset = offset + limit;
  if (nextOffset >= total) return undefined;
  const parts = [
    WORKSPACE_INFO_COMMAND,
    `--${section}`,
    `--offset ${nextOffset}`,
    `--limit ${limit}`,
  ];
  if (options.query?.trim()) parts.push(`--query ${shellQuoted(options.query.trim())}`);
  if (options.joined) parts.push("--joined");
  return parts.join(" ");
}

function summary(result: WorkspaceInfoResult): string {
  const channels = result.channels ?? [];
  const hints = [
    ...WORKSPACE_INFO_SECTIONS.map((section) => `${WORKSPACE_INFO_COMMAND} --${section}`),
    "coforge channel info <name>",
    "coforge user info <name>",
  ];
  return `${[
    "## Workspace",
    "",
    `Channels: ${channels.length} visible (${channels.filter((channel) => channel.joined).length} joined)`,
    `Agents: ${result.agents.length}`,
    `Humans: ${result.humans.length}`,
    `Projects: ${result.projects.length}`,
    `Computers: ${(result.computers ?? []).length}`,
    ...(result.serverRole ? [`Your role: ${result.serverRole}`] : []),
    "",
    "Narrow queries:",
    ...hints.map((hint) => `- ${hint}`),
    "",
    `Full dump: ${WORKSPACE_INFO_COMMAND} --full`,
  ].join("\n")}\n`;
}

function section(
  name: WorkspaceInfoSection,
  result: WorkspaceInfoResult,
  options: WorkspaceInfoOptions,
  now: number,
): string {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  const roleNote =
    "Role labels show server-level owner/admin authority; no role label means ordinary member.";
  const render = <T extends object>(
    title: string,
    intro: string[],
    rows: readonly T[],
    row: (item: T) => string,
  ) => {
    const matching = rows.filter((item) => includesQuery(row(item), options.query));
    const lines = [`## ${title}`, "", ...intro];
    const shown = matching.slice(offset, offset + limit);
    if (shown.length === 0) lines.push("(none)");
    else lines.push(...shown.map(row));
    return `${lines.join("\n")}${pageFooter({
      total: matching.length,
      offset,
      limit,
      nextCommand: nextCommand(name, options, offset, limit, matching.length),
    })}`;
  };
  if (name === "channels") {
    const rows = (result.channels ?? []).filter((channel) => !options.joined || channel.joined);
    return render(
      "Workspace Channels",
      [
        "All channels in the Workspace are public. Do not disclose private conversations outside their channel.",
      ],
      rows,
      (channel) => channelRow(channel, now, true),
    );
  }
  if (name === "agents") return render("Workspace Agents", [roleNote], result.agents, agentRow);
  if (name === "humans") return render("Workspace Humans", [roleNote], result.humans, humanRow);
  if (name === "projects") return render("Workspace Projects", [], result.projects, projectRow);
  return render("Workspace Computers", [], result.computers ?? [], computerRow);
}

function full(result: WorkspaceInfoResult, now: number): string {
  const runtime = formatCurrentRuntimeBlock(cliRuntimeContext(result.runtimeContext));
  const list = <T>(rows: readonly T[], row: (item: T) => string) =>
    rows.length > 0 ? rows.map((item) => `  - ${row(item)}`) : ["  (none)"];
  return `${[
    "## Workspace",
    "",
    ...(runtime ? [runtime, ""] : []),
    ...(result.serverRole ? ["### Current Agent", `- Role: ${result.serverRole}`, ""] : []),
    "### Channels",
    "Every channel in the Workspace appears, joined or not. Use channel attention commands (`coforge channel join`, `leave`, `mute`, `unmute`; `coforge thread unfollow`) for your own delivery state. Channel management commands (`coforge channel create`, `update`, `archive`, `unarchive`, `add-member`, `remove-member`) work when your server role allows them, or, for update, archive, unarchive and remove-member, your channel-admin role in that channel; the server checks on each call, and a refusal says what is missing. There is no Agent command for changing channel roles. Run any subcommand with `--help` for syntax.",
    "Mute state is shown when the server provides it; otherwise it is omitted.",
    ...list(result.channels ?? [], (channel) => channelRow(channel, now, false)),
    "",
    "### Agents",
    "Other AI agents in this Workspace.",
    "Role labels show server-level owner/admin authority; no role label means ordinary member.",
    ...list(result.agents, agentRow),
    "",
    "### Humans",
    "To start a new DM, send to `@name` with `coforge message send --target @name`. To reply in an existing DM: reuse the target from received messages.",
    "Role labels show server-level owner/admin authority; no role label means ordinary member.",
    ...list(result.humans, humanRow),
    "",
    "### Projects",
    ...list(result.projects, projectRow),
    "",
    "### Computers",
    ...list(result.computers ?? [], computerRow),
  ].join("\n")}\n`;
}

export function formatWorkspaceInfo(
  result: WorkspaceInfoResult,
  options: WorkspaceInfoOptions,
  now = Date.now(),
): string {
  if (options.json) {
    const runtimeContext = cliRuntimeContext(result.runtimeContext);
    return JSON.stringify(runtimeContext ? { ...result, runtimeContext } : result);
  }
  if (options.full) return full(result, now);
  const selected = WORKSPACE_INFO_SECTIONS.filter((name) => options[name]);
  if (selected.length === 0) return summary(result);
  return selected.map((name) => section(name, result, options, now)).join("\n");
}
