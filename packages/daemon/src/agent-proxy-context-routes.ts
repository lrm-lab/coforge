import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { type ProxyRoute, defineRoute } from "./agent-proxy-route";
import { exactPath } from "./agent-proxy-paths";

export const CONTEXT_PROXY_ROUTES: readonly ProxyRoute[] = [
  defineRoute({
    family: "agent-api/context-search",
    method: agentApiRoutes.proxy.context.search.method,
    match: exactPath(agentApiRoutes.proxy.context.search.path),
    body: "none",
    handler: "agentContext",
    parse: ({ url }) => {
      const messageId = url.searchParams.get("message_id");
      const sessionId = url.searchParams.get("session_id");
      const query = url.searchParams.get("query");
      if (!messageId || !sessionId || !query)
        throw new Error("message_id, session_id, and query are required");
      return {
        mode: "search" as const,
        messageId,
        sessionId,
        query,
        limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
        offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : undefined,
      };
    },
  }),
  defineRoute({
    family: "agent-api/context-read",
    method: agentApiRoutes.proxy.context.read.method,
    match: exactPath(agentApiRoutes.proxy.context.read.path),
    body: "none",
    handler: "agentContext",
    parse: ({ url }) => {
      const messageId = url.searchParams.get("message_id");
      const sessionId = url.searchParams.get("session_id");
      const around = url.searchParams.get("around");
      if (!messageId || !sessionId || !around)
        throw new Error("message_id, session_id, and around are required");
      return {
        mode: "read" as const,
        messageId,
        sessionId,
        around,
        limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
        page: url.searchParams.has("page") ? Number(url.searchParams.get("page")) : undefined,
      };
    },
  }),
];
