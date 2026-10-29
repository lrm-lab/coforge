import { invalidArgument } from "./command-help";

/** What `message read` asks for: a history window (at most one anchor, and a page size), or the
 * messages after the Agent's read position (`unread`), which no anchor combines with. */
export type MessageReadOptions = {
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  unread?: boolean;
};

const READ_VALUE_FLAGS = ["--target", "--before", "--after", "--around", "--limit"];
const READ_BOOLEAN_FLAGS = ["--unread"];
/** The server's largest page; a bigger `--limit` is refused rather than silently capped. */
export const MESSAGE_READ_MAX_LIMIT = 100;

/** The target and window of `message read`, from the arguments after `message`; undefined when the
 * target is missing or the window is not well formed. Flags may come in any order. */
export function parseMessageReadArgs(
  args: readonly string[],
): ({ target: string } & MessageReadOptions) | undefined {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 2; index < args.length; index++) {
    const name = args[index]!;
    if (READ_BOOLEAN_FLAGS.includes(name)) {
      if (booleans.has(name))
        throw invalidArgument("message read", `"${name}" is given more than once.`);
      booleans.add(name);
      continue;
    }
    if (!READ_VALUE_FLAGS.includes(name))
      throw invalidArgument("message read", `Unknown argument "${name}".`);
    if (values.has(name))
      throw invalidArgument("message read", `"${name}" is given more than once.`);
    const value = args[++index];
    if (!value) throw invalidArgument("message read", `"${name}" needs a value.`);
    values.set(name, value);
  }
  const target = values.get("--target");
  const limit = values.get("--limit");
  if (limit !== undefined) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MESSAGE_READ_MAX_LIMIT)
      throw invalidArgument(
        "message read",
        `--limit must be a whole number from 1 to ${MESSAGE_READ_MAX_LIMIT}; "${limit}" is not.`,
      );
  }
  const options: MessageReadOptions = {
    ...(booleans.has("--unread") ? { unread: true } : {}),
    ...(limit !== undefined ? { limit: Number(limit) } : {}),
    ...(values.has("--before") ? { before: values.get("--before")! } : {}),
    ...(values.has("--after") ? { after: values.get("--after")! } : {}),
    ...(values.has("--around") ? { around: values.get("--around")! } : {}),
  };
  const anchors = [options.before, options.after, options.around].filter(Boolean);
  if (options.unread && anchors.length)
    throw invalidArgument(
      "message read",
      "--unread reads forward from your read position; it cannot combine with --before, --after or --around.",
    );
  if (anchors.length > 1)
    throw invalidArgument("message read", "Give at most one of --before, --after and --around.");
  if (!target)
    throw invalidArgument(
      "message read",
      "--target is required, for example '#general' or '@ada'.",
    );
  return { target, ...options };
}
