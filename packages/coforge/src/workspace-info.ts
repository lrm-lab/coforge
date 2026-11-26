import { parseArgs as nodeParseArgs } from "node:util";
import type { WorkspaceInfoResponse } from "@lrm/coforge-sdk/internal";

export type WorkspaceInfoOptions = {
  channels?: boolean;
  agents?: boolean;
  humans?: boolean;
  projects?: boolean;
  /** With `projects`: one Project's full row, named by slug. */
  project?: string;
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

const WORKSPACE_INFO_OPTIONS = {
  channels: { type: "boolean" },
  agents: { type: "boolean" },
  humans: { type: "boolean" },
  projects: { type: "boolean" },
  computers: { type: "boolean" },
  full: { type: "boolean" },
  joined: { type: "boolean" },
  json: { type: "boolean" },
  query: { type: "string" },
  limit: { type: "string" },
  offset: { type: "string" },
} as const;

export function parseWorkspaceInfoArgs(args: readonly string[]): WorkspaceInfoInvocation {
  const parsed = nodeParseArgs({
    args: [...args],
    options: WORKSPACE_INFO_OPTIONS,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const options: WorkspaceInfoOptions = {};
  let limit: string | undefined;
  let offset: string | undefined;
  let previousWasProjects = false;
  for (const token of parsed.tokens) {
    if (token.kind === "option-terminator") throw new Error(WORKSPACE_INFO_USAGE);
    if (token.kind === "positional") {
      if (!previousWasProjects || options.project !== undefined)
        throw new Error(WORKSPACE_INFO_USAGE);
      options.project = token.value;
      previousWasProjects = false;
      continue;
    }
    previousWasProjects = false;
    if (!Object.hasOwn(WORKSPACE_INFO_OPTIONS, token.name)) throw new Error(WORKSPACE_INFO_USAGE);
    const spec = WORKSPACE_INFO_OPTIONS[token.name as keyof typeof WORKSPACE_INFO_OPTIONS];
    if (spec.type === "boolean") {
      if (token.inlineValue) throw new Error(WORKSPACE_INFO_USAGE);
      options[token.name as "full"] = true;
      previousWasProjects = token.name === "projects";
    } else {
      if (token.value === undefined) throw new Error(WORKSPACE_INFO_USAGE);
      if (token.name === "query") options.query = token.value;
      else if (token.name === "limit") limit = token.value;
      else offset = token.value;
    }
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
  if (options.project !== undefined && !sections.every((section) => section === "projects"))
    throw new Error("<slug> after --projects cannot be combined with another section");
  const parsedLimit = nonNegativeInt(limit, "--limit", 50);
  if (parsedLimit <= 0) throw new Error("--limit must be greater than 0");
  if (limit !== undefined) options.limit = parsedLimit;
  if (offset !== undefined) options.offset = nonNegativeInt(offset, "--offset", 0);
  return { command: "workspace.info", ...options };
}
