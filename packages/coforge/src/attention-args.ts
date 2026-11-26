import { isAgentInboxView, AGENT_INBOX_VIEWS, type AgentInboxView } from "@lrm/coforge-sdk/agent";
import { CliError } from "#src/cli-error";
import { parseCliFlags } from "./cli-flags";
import {
  parseInboxDismissArgs,
  parseInboxReadArgs,
  type InboxDismissInvocation,
  type InboxReadInvocation,
} from "#src/inbox-commands";
import {
  isChannelTarget,
  MESSAGE_ANCHOR_SOURCE,
  UUID_LIKE_SOURCE,
} from "@lrm/coforge-sdk/internal";

export type InboxInvocation =
  | {
      command: "inbox-check";
      json?: boolean;
      view?: AgentInboxView;
      before?: number;
    }
  | InboxReadInvocation
  | InboxDismissInvocation;
export type ChannelInvocation = { command: "mute" | "unmute"; target: string };
export type ThreadInvocation =
  | { command: "thread-follow"; target: string }
  | { command: "thread-unfollow"; target: string; reason?: string }
  | { command: "thread-list" };

const THREAD_TARGET = new RegExp(
  `^#[a-z0-9][a-z0-9_-]{0,31}:(?:${MESSAGE_ANCHOR_SOURCE}|${UUID_LIKE_SOURCE})$`,
  "i",
);

function parseMuteTarget(args: readonly string[], command: string): string {
  const { values, positionals } = parseCliFlags({
    args,
    options: { target: { type: "string" } },
    maxPositionals: 1,
    duplicates: "error-strings",
    onError() {
      throw new Error(`Usage: coforge channel ${command} [<target>] [--target <target>]`);
    },
  });
  const positional = positionals[0]?.trim();
  const flagged = values.target?.trim();
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

const FOLLOW_USAGE = "Usage: coforge thread follow [<thread>] [--target <thread>]";
const UNFOLLOW_USAGE = "Usage: coforge thread unfollow --target <thread> [--reason <text>]";

function parseFollowArgs(args: readonly string[]): ThreadInvocation {
  const { values, positionals } = parseCliFlags({
    args,
    options: { target: { type: "string" } },
    maxPositionals: 1,
    duplicates: "error-strings",
    onError() {
      throw new Error(FOLLOW_USAGE);
    },
  });
  const positional = positionals[0]?.trim();
  const flagged = values.target?.trim();
  if (positional && flagged && positional !== flagged)
    throw new CliError({
      code: "INVALID_ARG",
      message:
        "Positional thread and --target must refer to the same thread when both are provided",
      retryable: false,
    });
  const target = flagged || positional;
  if (!target) throw new Error(FOLLOW_USAGE);
  if (!THREAD_TARGET.test(target))
    throw new CliError({
      code: "INVALID_TARGET",
      message: "Thread must be a thread target like '#channel:abcd1234'.",
      retryable: false,
    });
  return { command: "thread-follow", target };
}

function parseUnfollowArgs(args: readonly string[]): ThreadInvocation {
  const { values } = parseCliFlags({
    args,
    options: {
      target: { type: "string" },
      reason: { type: "string" },
    },
    duplicates: "error-strings",
    onError() {
      throw new Error(UNFOLLOW_USAGE);
    },
  });
  const target = values.target?.trim();
  const reason = values.reason?.trim();
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

function parseInboxCheckArgs(args: readonly string[]): InboxInvocation {
  const { values } = parseCliFlags({
    args,
    options: {
      json: { type: "boolean" },
      view: { type: "string" },
      before: { type: "string" },
    },
    duplicates: "error-strings",
    onError() {
      throw new Error(INBOX_USAGE);
    },
  });
  const json = values.json === true;
  const view = values.view?.trim();
  const before = values.before?.trim();
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
  if (args[0] === "thread" && args[1] === "follow") return parseFollowArgs(args.slice(2));
  if (args[0] === "thread" && args[1] === "unfollow") return parseUnfollowArgs(args.slice(2));
  if (args[0] === "thread" && args[1] === "list") {
    if (args.length > 2) throw new Error("Usage: coforge thread list");
    return { command: "thread-list" };
  }
  if (args[0] === "inbox" && args[1] === "check") return parseInboxCheckArgs(args.slice(2));
  if (args[0] === "inbox" && args[1] === "read") return parseInboxReadArgs(args.slice(2));
  if (args[0] === "inbox" && args[1] === "dismiss") return parseInboxDismissArgs(args.slice(2));
  return undefined;
}

/** A command that changes or lists what reaches the Agent, run by `runAttention`. */
export type AttentionInvocation = ChannelInvocation | ThreadInvocation;

export function isAttentionInvocation(invocation: {
  command: string;
}): invocation is AttentionInvocation {
  return ["mute", "unmute", "thread-follow", "thread-unfollow", "thread-list"].includes(
    invocation.command,
  );
}
