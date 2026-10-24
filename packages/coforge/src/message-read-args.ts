/** What `message read` asks for: a history window (at most one anchor, and a page size), or the
 * messages after the Agent's read position (`unread`), which no anchor combines with. */
export type MessageReadOptions = {
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  unread?: boolean;
};

const READ_FLAGS = ["--before", "--after", "--around", "--limit"];

/** The target and window of `message read`, from the arguments after `message`; undefined when the
 * target is missing or the window is not well formed. */
export function parseMessageReadArgs(
  args: readonly string[],
): ({ target: string } & MessageReadOptions) | undefined {
  const target = args[2] === "--target" ? args[3] : undefined;
  const options: MessageReadOptions = {};
  for (let i = 4; i < args.length; i++) {
    const name = args[i];
    if (name === "--unread") {
      if (options.unread) throw new Error("Usage:");
      options.unread = true;
      continue;
    }
    const value = args[++i];
    if (!name || !READ_FLAGS.includes(name) || !value) throw new Error("Usage:");
    if (name === "--limit") {
      const limit = Number(value);
      if (!Number.isInteger(limit)) throw new Error("Usage:");
      options.limit = limit;
    } else if (name === "--before") options.before = value;
    else if (name === "--after") options.after = value;
    else options.around = value;
  }
  const anchors = [options.before, options.after, options.around].filter(Boolean);
  const limitInRange = options.limit === undefined || (options.limit >= 1 && options.limit <= 100);
  const anchored = anchors.length === 0 || (anchors.length === 1 && !options.unread);
  return target && anchored && limitInRange ? { target, ...options } : undefined;
}
