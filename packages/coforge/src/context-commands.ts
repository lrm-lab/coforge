import type {
  AgentContextQueryResponse,
  AgentContextReadRequest,
  AgentContextSearchRequest,
} from "@lrm/coforge-sdk/agent";
import { parseCliFlags, type CliFlagOptions } from "./cli-flags";

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
  const options: CliFlagOptions =
    sub === "search"
      ? {
          json: { type: "boolean" },
          "message-id": { type: "string" },
          "session-id": { type: "string" },
          query: { type: "string" },
          limit: { type: "string" },
          offset: { type: "string" },
        }
      : {
          json: { type: "boolean" },
          "message-id": { type: "string" },
          "session-id": { type: "string" },
          around: { type: "string" },
          limit: { type: "string" },
          page: { type: "string" },
        };
  const { values } = parseCliFlags({
    args: args.slice(1),
    options,
    duplicates: "error-strings",
    onError(error) {
      if (error.kind === "duplicate") throw new Error(`unknown or repeated flag: ${error.flag}`);
      if (error.kind === "unknown" && error.raw.startsWith("--"))
        throw new Error(`unknown or repeated flag: ${error.raw}`);
      throw new Error("Usage: coforge context search|read --message-id <id> --session-id <id> ...");
    },
  });
  const json = values.json === true;
  const messageId = values["message-id"] as string | undefined;
  const sessionId = values["session-id"] as string | undefined;
  if (!messageId || !sessionId) throw new Error("--message-id and --session-id are required");
  const number = (name: string) => {
    const value = values[name] as string | undefined;
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
      throw new Error(`--${name} must be a non-negative integer`);
    return parsed;
  };
  if (sub === "search") {
    const query = values.query as string | undefined;
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
  const around = values.around as string | undefined;
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
