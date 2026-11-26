import { refuseTaskRef } from "./task-target-refusal";
import { invalidArgument } from "./command-help";
import { cliFlagBadToken, parseCliFlags } from "./cli-flags";

export type MessageReadOptions = {
  before?: string;
  after?: string;
  around?: string;
  limit?: number;
  unread?: boolean;
};

export const MESSAGE_READ_MAX_LIMIT = 100;

export function parseMessageReadArgs(
  args: readonly string[],
): ({ target: string } & MessageReadOptions) | undefined {
  const { values: parsed } = parseCliFlags({
    args: args.slice(2),
    options: {
      target: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      around: { type: "string" },
      limit: { type: "string" },
      unread: { type: "boolean" },
    },
    allowEmptyValues: false,
    duplicates: "error",
    onError(error) {
      if (error.kind === "missing-value")
        throw invalidArgument("message read", `"${error.flag}" needs a value.`);
      if (error.kind === "duplicate")
        throw invalidArgument("message read", `"${error.flag}" is given more than once.`);
      throw invalidArgument("message read", `Unknown argument "${cliFlagBadToken(error)}".`);
    },
  });
  const values = new Map<string, string>();
  for (const [name, flag] of [
    ["before", "--before"],
    ["after", "--after"],
    ["around", "--around"],
    ["limit", "--limit"],
  ] as const) {
    const value = parsed[name];
    if (value !== undefined) values.set(flag, value);
  }
  const target = parsed.target;
  const options = readWindowOptions("message read", values, parsed.unread === true);
  if (!target)
    throw invalidArgument(
      "message read",
      "--target is required, for example '#general' or '@ada'.",
    );
  refuseTaskRef("read", target, args);
  return { target, ...options };
}

/** The window a read asks for, from its `--before|--after|--around|--limit` values and `--unread`;
 * `command` names the command in a refusal. */
export function readWindowOptions(
  command: string,
  values: ReadonlyMap<string, string>,
  unread: boolean,
): MessageReadOptions {
  const limit = values.get("--limit");
  if (limit !== undefined) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MESSAGE_READ_MAX_LIMIT)
      throw invalidArgument(
        command,
        `--limit must be a whole number from 1 to ${MESSAGE_READ_MAX_LIMIT}; "${limit}" is not.`,
      );
  }
  const options: MessageReadOptions = {
    ...(unread ? { unread: true } : {}),
    ...(limit !== undefined ? { limit: Number(limit) } : {}),
    ...(values.has("--before") ? { before: values.get("--before")! } : {}),
    ...(values.has("--after") ? { after: values.get("--after")! } : {}),
    ...(values.has("--around") ? { around: values.get("--around")! } : {}),
  };
  const anchors = [options.before, options.after, options.around].filter(Boolean);
  if (options.unread && anchors.length)
    throw invalidArgument(
      command,
      "--unread reads forward from your read position; it cannot combine with --before, --after or --around.",
    );
  if (anchors.length > 1)
    throw invalidArgument(command, "Give at most one of --before, --after and --around.");
  return options;
}
