import type {
  AgentContextQueryResponse,
  AgentContextReadRequest,
  AgentContextSearchRequest,
} from "@lrm/coforge-sdk/agent";

export type ContextInvocation =
  | {
      command: "context-search";
      messageId: string;
      sessionId: string;
      query: string;
      limit?: number;
      offset?: number;
      json?: boolean;
    }
  | {
      command: "context-read";
      messageId: string;
      sessionId: string;
      around: string;
      limit?: number;
      page?: number;
      json?: boolean;
    };

export type ContextTransport = Readonly<{
  contextSearch?(
    request: Omit<AgentContextSearchRequest, "mode">,
  ): Promise<AgentContextQueryResponse>;
  contextRead?(request: Omit<AgentContextReadRequest, "mode">): Promise<AgentContextQueryResponse>;
}>;

export function parseContextArgs(args: readonly string[]): ContextInvocation {
  const sub = args[0];
  const values = new Map<string, string>();
  const allowed =
    sub === "search"
      ? new Set(["message-id", "session-id", "query", "limit", "offset"])
      : new Set(["message-id", "session-id", "around", "limit", "page"]);
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const name = args[index]!;
    if (name === "--json") {
      json = true;
      continue;
    }
    if (!name.startsWith("--") || args[index + 1] === undefined)
      throw new Error("Usage: coforge context search|read --message-id <id> --session-id <id> ...");
    const key = name.slice(2);
    if (!allowed.has(key) || values.has(key)) throw new Error(`unknown or repeated flag: ${name}`);
    values.set(key, args[++index]!);
  }
  const messageId = values.get("message-id");
  const sessionId = values.get("session-id");
  if (!messageId || !sessionId) throw new Error("--message-id and --session-id are required");
  const number = (name: string) => {
    const value = values.get(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
      throw new Error(`--${name} must be a non-negative integer`);
    return parsed;
  };
  if (sub === "search") {
    const query = values.get("query");
    if (!query) throw new Error("--query is required");
    return {
      command: "context-search",
      messageId,
      sessionId,
      query,
      limit: number("limit"),
      offset: number("offset"),
      ...(json ? { json: true } : {}),
    };
  }
  const around = values.get("around");
  if (!around) throw new Error("--around is required");
  return {
    command: "context-read",
    messageId,
    sessionId,
    around,
    limit: number("limit"),
    page: number("page"),
    ...(json ? { json: true } : {}),
  };
}

export async function runContextCommand(
  invocation: ContextInvocation,
  transport: ContextTransport,
): Promise<string> {
  const result =
    invocation.command === "context-search"
      ? await transport.contextSearch?.({
          messageId: invocation.messageId,
          sessionId: invocation.sessionId,
          query: invocation.query,
          ...(invocation.limit === undefined ? {} : { limit: invocation.limit }),
          ...(invocation.offset === undefined ? {} : { offset: invocation.offset }),
        })
      : await transport.contextRead?.({
          messageId: invocation.messageId,
          sessionId: invocation.sessionId,
          around: invocation.around,
          ...(invocation.limit === undefined ? {} : { limit: invocation.limit }),
          ...(invocation.page === undefined ? {} : { page: invocation.page }),
        });
  if (!result) throw new Error(`${invocation.command} transport is unavailable`);
  return invocation.json ? JSON.stringify(result) : JSON.stringify(result, null, 2);
}
