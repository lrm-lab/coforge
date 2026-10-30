import { invalidArgument } from "./command-help";
import { CliError } from "./cli-error";
import { readWindowOptions, type MessageReadOptions } from "./message-read-args";
import { resolveTaskRef, type TaskRef } from "./task-ref";

/** `coforge task view|reply|read|follow|unfollow|list --following`: the commands on a task's own
 * conversation. */
export type TaskConversationInvocation = { command: "task-conversation" } & (
  | { op: "view"; task: TaskRef; limit?: number }
  | { op: "reply"; task: TaskRef; json?: boolean }
  | { op: "read"; task: TaskRef; options: MessageReadOptions }
  | { op: "follow"; task: TaskRef }
  | { op: "unfollow"; task: TaskRef; reason?: string }
  | { op: "following" }
);

type TaskConversationOp = Exclude<TaskConversationInvocation["op"], "following">;

/** What each command takes besides the task: flags with a value, and flags without one. */
const FLAGS: Record<TaskConversationOp, { values: string[]; switches: string[] }> = {
  view: { values: ["--limit"], switches: [] },
  reply: { values: [], switches: ["--json"] },
  read: { values: ["--before", "--after", "--around", "--limit"], switches: ["--unread"] },
  follow: { values: [], switches: [] },
  unfollow: { values: ["--reason"], switches: [] },
};

const FOLLOWING_EXCLUSIVE = ["--mine", "--target", "--channel", "--status"];

function invalidArg(message: string): CliError {
  return new CliError({ code: "INVALID_ARG", message, retryable: false });
}

/** The arguments of a conversation command: the one positional ref, and each flag once. */
function collect(op: TaskConversationOp, args: readonly string[]) {
  const command = `task ${op}`;
  const { values: valueFlags, switches } = FLAGS[op];
  const values = new Map<string, string>();
  const given = new Set<string>();
  let positional: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const name = args[index]!;
    if (!name.startsWith("--")) {
      if (positional !== undefined)
        throw invalidArgument(command, "Give one task ref, not several.");
      positional = name;
      continue;
    }
    const known = ["--target", "--number", ...valueFlags, ...switches].includes(name);
    if (!known) throw invalidArgument(command, `Unknown argument "${name}".`);
    if (given.has(name)) throw invalidArgument(command, `"${name}" is given more than once.`);
    given.add(name);
    if (switches.includes(name)) continue;
    const value = args[++index];
    if (value === undefined) throw invalidArgument(command, `"${name}" needs a value.`);
    values.set(name, value);
  }
  return { positional, values, given };
}

function viewLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) < 1)
    throw invalidArg(`--limit must be a positive integer; got ${raw}`);
  if (Number(raw) > 20) throw invalidArg(`--limit is at most 20; got ${raw}`);
  return Number(raw);
}

/** `task list --following`, the one `list` form that is a conversation command. */
function parseFollowing(args: readonly string[]): TaskConversationInvocation {
  if (args.some((arg) => FOLLOWING_EXCLUSIVE.includes(arg)))
    throw invalidArg(
      "--following lists the task conversations you follow; it cannot be combined with --mine, --target, --channel or --status",
    );
  if (args.length !== 1) throw invalidArgument("task list", "--following takes no other argument.");
  return { command: "task-conversation", op: "following" };
}

/** The conversation command `args` (after `task`) is, or undefined when it is another `task`
 * operation. A malformed one is refused. */
export function parseTaskConversationArgs(
  args: readonly string[],
): TaskConversationInvocation | undefined {
  const op = args[0];
  if (op === "list" && args.includes("--following")) return parseFollowing(args.slice(1));
  if (!op || !Object.hasOwn(FLAGS, op)) return undefined;
  const { positional, values, given } = collect(op as TaskConversationOp, args.slice(1));
  const task = resolveTaskRef(positional, values.get("--target"), values.get("--number"));
  const invocation = { command: "task-conversation" as const, task };
  switch (op as TaskConversationOp) {
    case "view": {
      const limit = viewLimit(values.get("--limit"));
      return { ...invocation, op: "view", ...(limit === undefined ? {} : { limit }) };
    }
    case "reply":
      return { ...invocation, op: "reply", ...(given.has("--json") ? { json: true } : {}) };
    case "read":
      return {
        ...invocation,
        op: "read",
        options: readWindowOptions("task read", values, given.has("--unread")),
      };
    case "follow":
      return { ...invocation, op: "follow" };
    case "unfollow": {
      const reason = values.get("--reason")?.trim();
      if (reason && reason.length > 200)
        throw invalidArg(`--reason is at most 200 characters; got ${reason.length}`);
      return { ...invocation, op: "unfollow", ...(reason ? { reason } : {}) };
    }
  }
}
