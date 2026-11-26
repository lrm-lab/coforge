import type { AgentUserInfoResponse } from "@lrm/coforge-sdk/agent";
import { CliError } from "#src/cli-error";
import { formatUserInfo } from "#src/user-format";
import { parseCliFlags } from "./cli-flags";

export type UserInfoInvocation = {
  command: "user-info";
  name: string;
  json?: boolean;
  limit?: number;
  offset?: number;
};

const USER_INFO_USAGE = "Usage: coforge user info <name> [--limit <n>] [--offset <n>] [--json]";

function integer(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} must be a non-negative integer`);
  return Number(raw);
}

export function parseUserInfoArgs(args: readonly string[]): UserInfoInvocation {
  const { values, positionals } = parseCliFlags({
    args,
    options: {
      json: { type: "boolean" },
      limit: { type: "string" },
      offset: { type: "string" },
    },
    maxPositionals: 1,
    onError() {
      throw new Error(USER_INFO_USAGE);
    },
  });
  const limit = values.limit !== undefined ? integer(values.limit, "--limit") : undefined;
  const offset = values.offset !== undefined ? integer(values.offset, "--offset") : undefined;
  const trimmed = positionals[0]?.trim();
  if (!trimmed) throw new Error(USER_INFO_USAGE);
  const handle = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!handle) throw new Error("user name is required");
  if (limit !== undefined && limit <= 0) throw new Error("--limit must be greater than 0");
  if (limit !== undefined && limit > 200) throw new Error("--limit must be at most 200");
  return {
    command: "user-info",
    name: handle,
    ...(values.json ? { json: true } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
  };
}

/** A name the server does not know gets Raft's next step, built here because the envelope that
 * carries the refusal has room only for its message. */
function withUserNotFoundHint(error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== "USER_NOT_FOUND") return error;
  return new CliError({
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    correlationId: error.correlationId,
    proxy: error.proxy,
    suggestedNextAction:
      "Run `coforge workspace info --agents --query <name>` or `coforge workspace info --humans --query <name>` to inspect visible users.",
  });
}

/** `user info <name>`: the server's answer as JSON, or formatted and paged. */
export async function runUserInfo(
  userInfo: (name: string) => Promise<AgentUserInfoResponse>,
  invocation: UserInfoInvocation,
): Promise<AgentUserInfoResponse | string> {
  const result = await userInfo(invocation.name).catch((error) => {
    throw withUserNotFoundHint(error);
  });
  return invocation.json ? result : formatUserInfo(result, invocation);
}
