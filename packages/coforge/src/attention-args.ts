import { MESSAGE_ANCHOR_SOURCE, UUID_LIKE_SOURCE } from "@lrm/coforge-sdk/internal";

export type InboxInvocation = { command: "inbox-check"; json?: boolean };
export type ChannelInvocation = { command: "mute" | "unmute"; target: string };
export type ThreadInvocation = { command: "thread-unfollow"; target: string };

const CHANNEL_TARGET = /^#[a-z0-9][a-z0-9_-]{0,31}$/;
const THREAD_TARGET = new RegExp(
  `^#[a-z0-9][a-z0-9_-]{0,31}:(?:${MESSAGE_ANCHOR_SOURCE}|${UUID_LIKE_SOURCE})$`,
  "i",
);

/** `channel mute|unmute`, `thread unfollow` and `inbox check`: the commands that change or list
 * what reaches an Agent. Anything else, or a malformed form of these, is `undefined`. */
export function parseAttentionArgs(
  args: readonly string[],
): ChannelInvocation | ThreadInvocation | InboxInvocation | undefined {
  if (
    args[0] === "channel" &&
    (args[1] === "mute" || args[1] === "unmute") &&
    args[2] === "--target" &&
    args.length === 4 &&
    CHANNEL_TARGET.test(args[3] ?? "")
  )
    return { command: args[1], target: args[3]! };
  if (
    args[0] === "thread" &&
    args[1] === "unfollow" &&
    args[2] === "--target" &&
    args.length === 4 &&
    THREAD_TARGET.test(args[3] ?? "")
  )
    return { command: "thread-unfollow", target: args[3]! };
  if (args[0] === "inbox" && args[1] === "check") {
    if (args.length === 2) return { command: "inbox-check" };
    if (args.length === 3 && args[2] === "--json") return { command: "inbox-check", json: true };
  }
  return undefined;
}
