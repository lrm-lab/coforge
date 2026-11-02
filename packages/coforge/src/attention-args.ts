import { isAgentInboxView, AGENT_INBOX_VIEWS, type AgentInboxView } from "@lrm/coforge-sdk/agent";
import { CliError } from "#src/cli-error";
import {
  isChannelTarget,
  MESSAGE_ANCHOR_SOURCE,
  UUID_LIKE_SOURCE,
} from "@lrm/coforge-sdk/internal";

export type InboxInvocation = {
  command: "inbox-check";
  json?: boolean;
  view?: AgentInboxView;
  before?: number;
};
export type ChannelInvocation = { command: "mute" | "unmute"; target: string };
export type ThreadInvocation =
  | { command: "thread-unfollow"; target: string; reason?: string }
  | { command: "thread-list" };

const THREAD_TARGET = new RegExp(
  `^#[a-z0-9][a-z0-9_-]{0,31}:(?:${MESSAGE_ANCHOR_SOURCE}|${UUID_LIKE_SOURCE})$`,
  "i",
);

/** The channel a mute names, as a positional or `--target`; both must agree. A DM, a thread or
 * anything else that is not `#channel` is `INVALID_TARGET`. */
function parseMuteTarget(args: readonly string[], command: string): string {
  let positional: string | undefined;
  let flagged: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target" && flagged === undefined && args[index + 1] !== undefined) {
      flagged = args[index + 1]!.trim();
      index += 1;
    } else if (arg !== undefined && !arg.startsWith("--") && positional === undefined)
      positional = arg.trim();
    else throw new Error(`Usage: coforge channel ${command} [<target>] [--target <target>]`);
  }
  if (positional && flagged && positional !== flagged)
    throw new CliError({
      code: "INVALID_ARG",
      message:
        "Positional target and --target must refer to the same channel when both are provided",
      retryable: false,
    });
  const target = flagged || positional || "";
  if (!isChannelTarget(target))
    throw new CliError({
      code: "INVALID_TARGET",
      message:
        "Target must be a channel in the form '#channel-name'. DMs and thread targets are not supported.",
      retryable: false,
    });
  return target;
}

const UNFOLLOW_USAGE = "Usage: coforge thread unfollow --target <thread> [--reason <text>]";

/** `thread unfollow --target <#channel:message-id> [--reason <text>]`. */
function parseUnfollowArgs(args: readonly string[]): ThreadInvocation {
  let target: string | undefined;
  let reason: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (value === undefined) throw new Error(UNFOLLOW_USAGE);
    if (args[index] === "--target" && target === undefined) target = value.trim();
    else if (args[index] === "--reason" && reason === undefined) reason = value.trim();
    else throw new Error(UNFOLLOW_USAGE);
  }
  if (target === undefined) throw new Error(UNFOLLOW_USAGE);
  if (!THREAD_TARGET.test(target))
    throw new CliError({
      code: "INVALID_TARGET",
      message: "Thread must be a thread target like '#channel:abcd1234'.",
      retryable: false,
    });
  return { command: "thread-unfollow", target, ...(reason ? { reason } : {}) };
}

const INBOX_USAGE = "Usage: coforge inbox check [--view unread|mentions] [--before <n>] [--json]";

/** `inbox check [--view unread|mentions] [--before <n>] [--json]`. */
function parseInboxCheckArgs(args: readonly string[]): InboxInvocation {
  let view: string | undefined;
  let before: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--view" && view === undefined && args[index + 1] !== undefined)
      view = args[++index]!.trim();
    else if (arg === "--before" && before === undefined && args[index + 1] !== undefined)
      before = args[++index]!.trim();
    else throw new Error(INBOX_USAGE);
  }
  const refuse = (message: string) =>
    new CliError({
      code: "INVALID_ARG",
      message,
      retryable: false,
      outputMode: json ? "json" : "text",
    });
  if (view !== undefined && !isAgentInboxView(view))
    throw refuse(`--view must be one of ${AGENT_INBOX_VIEWS.join(", ")}; got ${view}`);
  if (before !== undefined && !/^[1-9][0-9]*$/.test(before))
    throw refuse(
      `--before must be a positive integer cursor (the value printed on the More: line); got ${before}`,
    );
  return {
    command: "inbox-check",
    ...(json ? { json: true } : {}),
    ...(view ? { view } : {}),
    ...(before === undefined ? {} : { before: Number(before) }),
  };
}

/** `channel mute|unmute`, `thread unfollow` and `inbox check`: the commands that change or list
 * what reaches an Agent. Anything else, or a malformed form of these, is `undefined`. */
export function parseAttentionArgs(
  args: readonly string[],
): ChannelInvocation | ThreadInvocation | InboxInvocation | undefined {
  if (args[0] === "channel" && (args[1] === "mute" || args[1] === "unmute"))
    return { command: args[1], target: parseMuteTarget(args.slice(2), args[1]) };
  if (args[0] === "thread" && args[1] === "unfollow") return parseUnfollowArgs(args.slice(2));
  if (args[0] === "thread" && args[1] === "list") {
    if (args.length > 2) throw new Error("Usage: coforge thread list");
    return { command: "thread-list" };
  }
  if (args[0] === "inbox" && args[1] === "check") return parseInboxCheckArgs(args.slice(2));
  return undefined;
}

/** A command that changes or lists what reaches the Agent, run by `runAttention`. */
export type AttentionInvocation = ChannelInvocation | ThreadInvocation;

export function isAttentionInvocation(invocation: {
  command: string;
}): invocation is AttentionInvocation {
  return ["mute", "unmute", "thread-unfollow", "thread-list"].includes(invocation.command);
}
