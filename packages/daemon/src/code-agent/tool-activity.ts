import {
  AGENT_ACTIVITY_DETAIL_KIND,
  TOOL_ALIASES,
  toolActivityLabel,
  truncateCodePoints,
  truncateCodePointsWithEllipsis,
  type AgentActivityDetailKind,
} from "@lrm/coforge-sdk/internal";
import { redactTrajectoryText } from "#src/agent-runtime/activity-trajectory";
import { createAgentActivity } from "#src/agent-runtime/agent-activity";
import { collapseWhitespace } from "./agent-instructions";
import type { AgentRuntimeEvent } from "./contract";

// `TOOL_ALIASES` (shared with the web tool row labels — see
// `packages/coforge-sdk/src/internal/tool-display.ts`) resolves a provider's tool name
// to the canonical name this module allowlists an argument summary for. Keys are
// lowercase; do not infer an operation by inspecting arbitrary args.

// A canonical tool's summary is built from exactly one allowlisted argument
// field; every other tool (including "bash", handled separately, and any
// unrecognized canonical name) reports its name only.
const SUMMARY_KIND: Readonly<Record<string, "file_path" | "pattern" | "url" | "query">> = {
  read_file: "file_path",
  write_file: "file_path",
  edit_file: "file_path",
  glob: "pattern",
  grep: "pattern",
  web_fetch: "url",
  web_search: "query",
};

/** A normalized tool-start becomes an allowlisted Activity with its reported child lineage. */
export function toolStartActivity(event: Extract<AgentRuntimeEvent, { type: "tool-start" }>) {
  const activity = toolActivity(event.name, event.input, event.occurredAt);
  const { subagent } = event;
  return {
    ...activity,
    entries: activity.entries.map((entry) => ({ ...entry, ...(subagent ? { subagent } : {}) })),
  };
}

export function toolActivity(name: string, args: unknown, occurredAt?: string) {
  const input = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const canonical = TOOL_ALIASES[name.toLowerCase()] ?? name;

  if (canonical === "bash") {
    const bash = summarizeBash(input.command);
    return buildActivity(bash.summary, bash.toolName, occurredAt);
  }

  const kind = SUMMARY_KIND[canonical];
  const summary =
    kind === "file_path"
      ? allowlistedString(input.file_path ?? input.path, 200)
      : kind === "pattern"
        ? allowlistedString(input.pattern ?? input.query, 120)
        : kind === "url"
          ? allowlistedString(input.url, 200)
          : kind === "query"
            ? allowlistedString(input.query, 120)
            : undefined;
  return buildActivity(summary, canonical, occurredAt);
}

/** The Activity kind a tool start reports, one rule for provider tools and the CoForge CLI. */
function detailKindFor(toolName: string): AgentActivityDetailKind {
  if (toolName === "bash") return AGENT_ACTIVITY_DETAIL_KIND.RUNNING_COMMAND;
  if (toolName === "check_messages" || toolName === "receive_message")
    return AGENT_ACTIVITY_DETAIL_KIND.CHECKING_MESSAGES;
  return AGENT_ACTIVITY_DETAIL_KIND.TOOL_STARTED;
}

/**
 * `detail` is always the generic, argument-free label (`toolActivityLabel`) — never
 * the command, path or other summary — so the Agent status header can never leak one
 * (see `docs/observability/running-command-summary.md`). The summary itself, when there is one, travels only
 * in the entry's `toolInput`, sanitized to satisfy the SDK's `validToolInput` (at most
 * 200 code points, no control characters).
 */
function buildActivity(summary: string | undefined, toolName: string, occurredAt?: string) {
  const result = createAgentActivity(
    detailKindFor(toolName),
    "info",
    toolActivityLabel(toolName),
    occurredAt,
  );
  const toolInput = summary ? sanitizeToolInput(summary) : undefined;
  return {
    ...result,
    entries: [
      {
        kind: "tool_start" as const,
        toolName: sanitizeToolName(toolName),
        ...(toolInput ? { toolInput } : {}),
      },
    ],
  };
}

// Collapses control characters (including newlines) to a space, then collapses
// runs of whitespace and trims, so a multi-line or otherwise-invalid summary still
// satisfies the SDK's `validToolInput` instead of failing to decode on the wire.
function sanitizeToolInput(value: string): string {
  return truncateCodePoints(collapseWhitespace(value.replace(/[\x00-\x1f\x7f]/g, " ")), 200);
}

function summarizeBash(command: unknown): { summary: string | undefined; toolName: string } {
  if (typeof command !== "string") return { summary: undefined, toolName: "bash" };
  // A command outside the closed set of recognized CoForge invocations has no semantic identity
  // to report, so it falls through to the ordinary command summary below rather than reporting a
  // name that stands for "some CoForge command".
  const invocation = resolveCoforgeInvocation(command);
  if (invocation) return { summary: invocation.summary, toolName: invocation.tool };
  // The row carries the command as the Agent wrote it, cut at 100 code points with an ellipsis
  // like the reference client, so an inline script stays visible instead of the command
  // appearing to stop at its heredoc. Redaction is best-effort — a heredoc body is in scope, so
  // text the rules cannot recognise will show.
  return {
    summary: truncateCodePointsWithEllipsis(redactTrajectoryText(command), 100),
    toolName: "bash",
  };
}

type Args = readonly string[];
type CoforgeCliTool = { tool: string; summary?: (args: Args) => string | undefined };

const target = (args: Args) => flagValue(args, "--target");
const taskRef = (args: Args) => {
  const channel = target(args);
  const number = taskNumbers(args)[0];
  return channel && number !== undefined ? `${channel} #t${number}` : undefined;
};

// The closed set of CoForge CLI subcommands with a semantic identity, keyed by their leading
// words, and each one's summary format — both as the reference client 1.0.47 has them
// (`resolveRaftCliInvocation`, `summarizeToolInput`). Its labels are `TOOL_LABELS`. One
// deliberate difference: the reference client has no label for `list_channel_members`,
// `update_channel`, `archive_channel`, `unarchive_channel` or `remove_channel_member`, so it
// shows `Using <name>…` and no summary; here they have a label and report their channel.
const COFORGE_CLI_TOOLS: Readonly<Record<string, CoforgeCliTool>> = {
  "message send": { tool: "send_message", summary: target },
  "message check": { tool: "check_messages" },
  "message read": { tool: "read_history", summary: target },
  "message search": { tool: "search_messages", summary: (args) => flagValue(args, "--query") },
  "channel members": { tool: "list_channel_members", summary: (args) => args[0] },
  "channel update": { tool: "update_channel", summary: target },
  "channel lifecycle archive": { tool: "archive_channel", summary: target },
  "channel lifecycle unarchive": { tool: "unarchive_channel", summary: target },
  "channel remove-member": { tool: "remove_channel_member", summary: target },
  "channel add-member": { tool: "add_channel_member", summary: target },
  "channel join": { tool: "join_channel", summary: target },
  "channel leave": { tool: "leave_channel", summary: target },
  "task list": { tool: "list_tasks", summary: target },
  "task create": { tool: "create_tasks", summary: target },
  "task claim": {
    tool: "claim_tasks",
    summary: (args) => {
      const channel = target(args);
      const tasks = taskNumbers(args)
        .map((n) => `#t${n}`)
        .join(",");
      return channel && tasks ? `${channel} ${tasks}` : channel;
    },
  },
  "task unclaim": { tool: "unclaim_task", summary: taskRef },
  "task update": { tool: "update_task_status", summary: taskRef },
  "attachment upload": { tool: "upload_file", summary: (args) => flagValue(args, "--path") },
  "attachment view": { tool: "view_file" },
  "reminder schedule": {
    tool: "schedule_reminder",
    summary: (args) => {
      const title = flagValue(args, "--title");
      return title && truncateCodePointsWithEllipsis(title, 40);
    },
  },
  "reminder list": { tool: "list_reminders" },
  "reminder cancel": {
    tool: "cancel_reminder",
    summary: (args) => {
      const id = flagValue(args, "--id");
      return id && `#${truncateCodePoints(id, 8)}`;
    },
  },
};

/**
 * The semantic identity of a CoForge CLI invocation, or `null` when the command has none and
 * belongs in the ordinary command Activity. As in the reference client, a leading
 * `sh`/`bash`/`zsh -c` payload is looked into first; otherwise it is the first `coforge`
 * executable, after leading `NAME=value` assignments, in any `|`/`;`/`&&`/`||` segment.
 */
function resolveCoforgeInvocation(command: string): { tool: string; summary?: string } | null {
  let first = true;
  for (const tokens of shellSegments(command)) {
    const index = skipEnvAssignments(tokens);
    if (first) {
      first = false;
      const payload = shellPayload(tokens, index);
      const inner = payload === undefined ? null : resolveCoforgeInvocation(payload);
      if (inner) return inner;
    }
    if (isCoforgeExecutable(tokens[index])) return mapCoforgeSubcommand(tokens.slice(index + 1));
  }
  return null;
}

function mapCoforgeSubcommand(args: Args): { tool: string; summary?: string } | null {
  for (const words of [3, 2]) {
    const key = args.slice(0, words).join(" ");
    if (!Object.hasOwn(COFORGE_CLI_TOOLS, key)) continue;
    const { tool, summary } = COFORGE_CLI_TOOLS[key]!;
    return { tool, summary: summary?.(args.slice(words)) };
  }
  return null;
}

/** Every value of `flag`, given as `flag value` or `flag=value`. */
function flagValues(args: Args, flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === flag && i + 1 < args.length) values.push(args[++i]!);
    else if (arg.startsWith(`${flag}=`)) values.push(arg.slice(flag.length + 1));
  }
  return values;
}

/** The last value of `flag`, as the CLI parser would keep it. */
function flagValue(args: Args, flag: string): string | undefined {
  return flagValues(args, flag).at(-1);
}

function taskNumbers(args: Args): number[] {
  return flagValues(args, "--number")
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

function skipEnvAssignments(tokens: Args): number {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) index++;
  return index;
}

function executableBase(token: string): string {
  return token.slice(Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\")) + 1).toLowerCase();
}

function isCoforgeExecutable(token: string | undefined): boolean {
  return token !== undefined && executableBase(token) === "coforge";
}

/** The `-c` script (`-c`, `-lc`, …) when `tokens[index]` is `sh`, `bash` or `zsh`. */
function shellPayload(tokens: Args, index: number): string | undefined {
  const shell = tokens[index];
  if (shell === undefined || !["sh", "bash", "zsh"].includes(executableBase(shell)))
    return undefined;
  for (let i = index + 1; i < tokens.length; i++) {
    const arg = tokens[i]!;
    if (!arg.startsWith("-")) break;
    if (arg.endsWith("c")) return tokens[i + 1];
  }
  return undefined;
}

// Yields a shell command line's non-empty argv-like segments one at a time, honouring
// single/double quoting and backslash escapes, so a caller stops tokenising once it has its
// answer. A new segment starts at each unquoted `|`, `;`, `&&` or `||`; tokenising stops at the
// first unquoted `<<` or newline, so a heredoc body never reaches a token.
function* shellSegments(command: string): Generator<string[]> {
  let segment: string[] = [];
  let current = "";
  let inToken = false;
  const push = () => {
    if (inToken) segment.push(current);
    current = "";
    inToken = false;
  };
  let i = 0;
  while (i < command.length) {
    const ch = command[i]!;
    if (ch === "\n") break;
    if (ch === " " || ch === "\t") {
      push();
      i++;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      push();
      break;
    }
    if ((ch === "|" || ch === "&") && command[i + 1] === ch) {
      push();
      if (segment.length > 0) yield segment;
      segment = [];
      i += 2;
      continue;
    }
    if (ch === "|" || ch === ";") {
      push();
      if (segment.length > 0) yield segment;
      segment = [];
      i++;
      continue;
    }
    if (ch === "'") {
      inToken = true;
      i++;
      while (i < command.length && command[i] !== "'") {
        current += command[i];
        i++;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inToken = true;
      i++;
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1]!)) {
          current += command[i + 1];
          i += 2;
        } else {
          current += command[i];
          i++;
        }
      }
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      inToken = true;
      current += command[i + 1];
      i += 2;
      continue;
    }
    inToken = true;
    current += ch;
    i++;
  }
  push();
  if (segment.length > 0) yield segment;
}

function allowlistedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return truncateCodePoints(value, max);
}

function sanitizeToolName(name: string): string {
  return truncateCodePoints(name.replace(/[\x00-\x1f\x7f]/g, ""), 128) || "unknown";
}
