import { CliError } from "./cli-error";
import { invalidArgument } from "./command-help";
import type { ChannelCommand } from "@lrm/coforge-sdk/internal";

export type ChannelManagementInvocation = {
  command: "channel-manage";
  channel: Omit<ChannelCommand, "idempotencyKey">;
  json?: boolean;
};

const CHANNEL_MANAGEMENT_BOOLEAN_FLAGS = new Set(["--private", "--public", "--json"]);

/** `--public`/`--private` as a visibility, or none; both at once is refused, as Raft does. */
function visibilityFlag(values: Map<string, string>, command: string) {
  if (values.has("--public") && values.has("--private"))
    throw invalidArgument(command, "Use either --public or --private, not both.");
  if (values.has("--private")) return "private" as const;
  if (values.has("--public")) return "public" as const;
  return undefined;
}

/** Requires a regular channel target for `join`, `leave`, `update`, `lifecycle archive|unarchive`,
 * `add-member`, and `remove-member` — never for `info`/`members` (which accept a wider target
 * grammar) or `create` (which has no target at all). Rejects a thread target, an `@user` DM, or a
 * bare name with no leading `#`. */
function requireRegularChannelTarget(target: string): string {
  if (!/^#[a-z0-9][a-z0-9_-]{0,31}$/.test(target))
    throw new CliError({
      code: "INVALID_TARGET",
      message:
        "Target must be a regular channel in the form '#channel-name'. DMs and thread targets are not supported.",
      retryable: false,
    });
  return target;
}

/** Generic `--flag value` / `--boolean-flag` parser shared by the `channel` subcommands below. */
function parseChannelFlags(
  args: readonly string[],
  allowed: readonly string[],
  command = "channel",
): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!name || !allowed.includes(name))
      throw invalidArgument(
        command,
        `Unknown argument "${name}". Accepted: ${allowed.join(", ")}.`,
      );
    if (values.has(name)) throw invalidArgument(command, `"${name}" is given more than once.`);
    if (CHANNEL_MANAGEMENT_BOOLEAN_FLAGS.has(name)) {
      values.set(name, "true");
      continue;
    }
    const value = args[++index];
    if (!value) throw invalidArgument(command, `"${name}" needs a value.`);
    values.set(name, value);
  }
  return values;
}

/**
 * `channel info|members|join|leave|create|update|lifecycle archive|unarchive|add-member|
 * remove-member`. `mute`/`unmute` are parsed separately, above, and unchanged.
 */
export function parseChannelManagementArgs(args: readonly string[]): ChannelManagementInvocation {
  const sub = args[0];
  if (sub === "info" || sub === "members") {
    // The target is accepted positionally or as `--target`, in either order, as Raft does.
    let positional: string | undefined;
    let named: string | undefined;
    let json = false;
    const rest = args.slice(1);
    for (let index = 0; index < rest.length; index++) {
      const arg = rest[index]!;
      if (arg === "--json") json = true;
      else if (arg === "--target") {
        const value = rest[++index];
        if (!value) throw invalidArgument(`channel ${sub}`, "--target needs a value.");
        named = value;
      } else if (arg.startsWith("-"))
        throw invalidArgument(`channel ${sub}`, `Unknown argument "${arg}".`);
      else if (positional === undefined) positional = arg;
      else throw invalidArgument(`channel ${sub}`, `Unknown argument "${arg}".`);
    }
    const target = named ?? positional;
    if (!target) throw invalidArgument(`channel ${sub}`, "--target is required.");
    return {
      command: "channel-manage",
      channel: { operation: sub, target },
      ...(json ? { json } : {}),
    };
  }
  if (sub === "archive" || sub === "unarchive") {
    const values = parseChannelFlags(args.slice(1), ["--target", "--json"], `channel ${sub}`);
    const target = values.get("--target");
    if (!target) throw invalidArgument(`channel ${sub}`, "--target is required.");
    return {
      command: "channel-manage",
      channel: { operation: sub, target: requireRegularChannelTarget(target) },
      json: values.has("--json"),
    };
  }
  if (sub === "lifecycle") {
    const action = args[1];
    if (action !== "archive" && action !== "unarchive")
      throw invalidArgument("channel lifecycle", "Name archive or unarchive.");
    const values = parseChannelFlags(args.slice(2), ["--target", "--json"], `channel ${action}`);
    const target = values.get("--target");
    if (!target) throw invalidArgument(`channel ${action}`, "--target is required.");
    return {
      command: "channel-manage",
      channel: { operation: action, target: requireRegularChannelTarget(target) },
      json: values.has("--json"),
    };
  }
  if (sub === "join" || sub === "leave") {
    const values = parseChannelFlags(args.slice(1), ["--target", "--json"], `channel ${sub}`);
    const target = values.get("--target");
    if (!target) throw invalidArgument(`channel ${sub}`, "--target is required.");
    return {
      command: "channel-manage",
      channel: { operation: sub, target: requireRegularChannelTarget(target) },
      json: values.has("--json"),
    };
  }
  if (sub === "create") {
    const values = parseChannelFlags(args.slice(1), [
      "--name",
      "--description",
      "--private",
      "--json",
    ]);
    const name = values.get("--name");
    if (!name) throw invalidArgument("channel create", "--name is required.");
    return {
      command: "channel-manage",
      channel: {
        operation: "create",
        name,
        description: values.get("--description"),
        ...(values.has("--private") ? { visibility: "private" as const } : {}),
      },
      json: values.has("--json"),
    };
  }
  if (sub === "update") {
    const values = parseChannelFlags(args.slice(1), [
      "--target",
      "--name",
      "--description",
      "--public",
      "--private",
      "--json",
    ]);
    const visibility = visibilityFlag(values, "channel update");
    const target = values.get("--target");
    if (!target) throw invalidArgument("channel update", "--target is required.");
    const name = values.get("--name");
    const description = values.get("--description");
    if (name === undefined && description === undefined && visibility === undefined)
      throw invalidArgument(
        "channel update",
        "Provide at least one of --name, --description, --public, or --private.",
      );
    return {
      command: "channel-manage",
      channel: {
        operation: "update",
        target: requireRegularChannelTarget(target),
        name,
        description,
        ...(visibility ? { visibility } : {}),
      },
      json: values.has("--json"),
    };
  }
  if (sub === "add-member" || sub === "remove-member") {
    const values = parseChannelFlags(args.slice(1), ["--target", "--user", "--agent", "--json"]);
    const target = values.get("--target");
    const user = values.get("--user");
    const agent = values.get("--agent");
    if (!target) throw invalidArgument(`channel ${sub}`, "--target is required.");
    if ((user === undefined) === (agent === undefined))
      throw invalidArgument(`channel ${sub}`, "Give exactly one of --user and --agent.");
    return {
      command: "channel-manage",
      channel: { operation: sub, target: requireRegularChannelTarget(target), user, agent },
      json: values.has("--json"),
    };
  }
  throw invalidArgument(
    "channel",
    `"${sub ?? ""}" is not a channel subcommand. Accepted: info, members, join, leave, create, update, archive, unarchive, lifecycle, add-member, remove-member.`,
  );
}
