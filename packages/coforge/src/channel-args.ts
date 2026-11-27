import { CliError } from "./cli-error";
import { invalidArgument } from "./command-help";
import { cliFlagBadToken, parseCliFlags, type CliFlagOptions } from "./cli-flags";
import type { ChannelCommand } from "@lrm/coforge-sdk/internal";

export type ChannelManagementInvocation = {
  command: "channel-manage";
  channel: Omit<ChannelCommand, "idempotencyKey">;
  json?: boolean;
};

const CHANNEL_MANAGEMENT_BOOLEAN_FLAGS = new Set([
  "--private",
  "--public",
  "--no-announcement",
  "--json",
]);

const DM_ANNOUNCEMENT_TARGET = /^(?:dm:)?@[a-z0-9][a-z0-9_-]{0,63}(?:~(?:human|agent))?$/;

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

function parseChannelFlags(
  args: readonly string[],
  allowed: readonly string[],
  command = "channel",
): Map<string, string> {
  const options: CliFlagOptions = {};
  for (const flag of allowed) {
    options[flag.slice(2)] = {
      type: CHANNEL_MANAGEMENT_BOOLEAN_FLAGS.has(flag) ? "boolean" : "string",
    };
  }
  const { values: parsed } = parseCliFlags({
    args,
    options,
    allowEmptyValues: false,
    duplicates: "error",
    onError(error) {
      if (error.kind === "missing-value")
        throw invalidArgument(command, `"${error.flag}" needs a value.`);
      if (error.kind === "duplicate")
        throw invalidArgument(command, `"${error.flag}" is given more than once.`);
      throw invalidArgument(
        command,
        `Unknown argument "${cliFlagBadToken(error)}". Accepted: ${allowed.join(", ")}.`,
      );
    },
  });
  const values = new Map<string, string>();
  for (const flag of allowed) {
    const value = parsed[flag.slice(2)];
    if (value === true) values.set(flag, "true");
    else if (typeof value === "string") values.set(flag, value);
  }
  return values;
}

export function parseChannelManagementArgs(args: readonly string[]): ChannelManagementInvocation {
  const sub = args[0];
  if (sub === "info" || sub === "members") {
    const { values, positionals } = parseCliFlags({
      args: args.slice(1),
      options: {
        json: { type: "boolean" },
        target: { type: "string" },
      },
      maxPositionals: 1,
      allowEmptyValues: false,
      onError(error) {
        if (error.kind === "missing-value")
          throw invalidArgument(`channel ${sub}`, "--target needs a value.");
        throw invalidArgument(`channel ${sub}`, `Unknown argument "${cliFlagBadToken(error)}".`);
      },
    });
    const target = values.target ?? positionals[0];
    if (!target) throw invalidArgument(`channel ${sub}`, "--target is required.");
    return {
      command: "channel-manage",
      channel: { operation: sub, target },
      ...(values.json ? { json: true } : {}),
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
    const values = parseChannelFlags(
      args.slice(1),
      [
        "--target",
        "--name",
        "--description",
        "--public",
        "--private",
        "--announcement",
        "--no-announcement",
        "--json",
      ],
      "channel update",
    );
    const visibility = visibilityFlag(values, "channel update");
    const target = values.get("--target");
    if (!target) throw invalidArgument("channel update", "--target is required.");
    const name = values.get("--name");
    const description = values.get("--description");
    if (values.has("--announcement") && values.has("--no-announcement"))
      throw invalidArgument(
        "channel update",
        "Use either --announcement or --no-announcement, not both.",
      );
    const announcement = values.has("--no-announcement") ? null : values.get("--announcement");
    if (
      name === undefined &&
      description === undefined &&
      visibility === undefined &&
      announcement === undefined
    )
      throw invalidArgument(
        "channel update",
        "Provide at least one of --name, --description, --public, --private, --announcement, or --no-announcement.",
      );
    const isDmTarget = DM_ANNOUNCEMENT_TARGET.test(target);
    if (isDmTarget) {
      if (name !== undefined || description !== undefined || visibility !== undefined)
        throw invalidArgument(
          "channel update",
          "A DM has no name, description, or visibility to change; only --announcement or --no-announcement is supported.",
        );
    }
    return {
      command: "channel-manage",
      channel: {
        operation: "update",
        target: isDmTarget ? target : requireRegularChannelTarget(target),
        name,
        description,
        ...(visibility ? { visibility } : {}),
        ...(announcement !== undefined ? { announcement } : {}),
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
