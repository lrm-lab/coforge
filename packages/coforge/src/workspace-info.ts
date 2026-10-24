import type { WorkspaceInfoResponse } from "@lrm/coforge-sdk/internal";

export type WorkspaceInfoOptions = {
  channels?: boolean;
  agents?: boolean;
  humans?: boolean;
  projects?: boolean;
  computers?: boolean;
  full?: boolean;
  json?: boolean;
  /** With `channels`: only the channels this Agent has joined. */
  joined?: boolean;
  query?: string;
  limit?: number;
  offset?: number;
};
export type WorkspaceInfoInvocation = { command: "workspace.info" } & WorkspaceInfoOptions;
/** `whoami`'s view of the `workspace_info` result. */
export type WorkspaceInfoResult = WorkspaceInfoResponse;

export const WORKSPACE_INFO_SECTIONS = [
  "channels",
  "agents",
  "humans",
  "projects",
  "computers",
] as const;
export type WorkspaceInfoSection = (typeof WORKSPACE_INFO_SECTIONS)[number];

const WORKSPACE_INFO_USAGE =
  "Usage: coforge workspace info [--channels|--agents|--humans|--projects|--computers|--full] [--joined] [--query <text>] [--limit <n>] [--offset <n>] [--json]";
const SECTION_LIST = "--channels, --agents, --humans, --projects, or --computers";

function nonNegativeInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  return Number(raw);
}

/** `workspace info`, with Raft's sections, paging and refusals; the rows it pages are the ones
 * the server returned in one response, so `--limit`/`--offset` page them here. */
export function parseWorkspaceInfoArgs(args: readonly string[]): WorkspaceInfoInvocation {
  const options: WorkspaceInfoOptions = {};
  let limit: string | undefined;
  let offset: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--query" || flag === "--limit" || flag === "--offset") {
      const value = args[++i];
      if (value === undefined) throw new Error(WORKSPACE_INFO_USAGE);
      if (flag === "--query") options.query = value;
      else if (flag === "--limit") limit = value;
      else offset = value;
    } else if (
      flag !== undefined &&
      [
        "--full",
        "--joined",
        "--json",
        ...WORKSPACE_INFO_SECTIONS.map((name) => `--${name}`),
      ].includes(flag)
    )
      options[flag.slice(2) as "full"] = true;
    else throw new Error(WORKSPACE_INFO_USAGE);
  }
  const sections = WORKSPACE_INFO_SECTIONS.filter((section) => options[section]);
  const listModifier =
    options.joined || options.query !== undefined || limit !== undefined || offset !== undefined;
  if (options.full && sections.length > 0)
    throw new Error(`--full cannot be combined with ${SECTION_LIST}`);
  if (options.json && (options.full || sections.length > 0 || listModifier))
    throw new Error("--json prints the whole inventory and cannot be combined with other options");
  if (sections.length === 0 && listModifier)
    throw new Error(`--query, --limit, --offset, and --joined require ${SECTION_LIST}`);
  if (options.joined && sections.some((section) => section !== "channels"))
    throw new Error("--joined can only be used with --channels");
  const parsedLimit = nonNegativeInt(limit, "--limit", 50);
  if (parsedLimit <= 0) throw new Error("--limit must be greater than 0");
  if (limit !== undefined) options.limit = parsedLimit;
  if (offset !== undefined) options.offset = nonNegativeInt(offset, "--offset", 0);
  return { command: "workspace.info", ...options };
}
