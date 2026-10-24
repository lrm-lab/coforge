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

/** `user info <name>`: the memberships it lists are paged here, 50 at a time by default. */
export function parseUserInfoArgs(args: readonly string[]): UserInfoInvocation {
  let name: string | undefined;
  let json = false;
  let limit: number | undefined;
  let offset: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") json = true;
    else if (arg === "--limit" || arg === "--offset") {
      const raw = args[++index];
      if (raw === undefined) throw new Error(USER_INFO_USAGE);
      if (arg === "--limit") limit = integer(raw, arg);
      else offset = integer(raw, arg);
    } else if (arg !== undefined && !arg.startsWith("--") && name === undefined) name = arg;
    else throw new Error(USER_INFO_USAGE);
  }
  const trimmed = name?.trim();
  if (!trimmed) throw new Error(USER_INFO_USAGE);
  const handle = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!handle) throw new Error("user name is required");
  if (limit !== undefined && limit <= 0) throw new Error("--limit must be greater than 0");
  if (limit !== undefined && limit > 200) throw new Error("--limit must be at most 200");
  return {
    command: "user-info",
    name: handle,
    ...(json ? { json: true } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
  };
}
