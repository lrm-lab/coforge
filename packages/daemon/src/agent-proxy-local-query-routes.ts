import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { type ProxyRoute, defineRoute } from "./agent-proxy-route";
import { exactPath } from "./agent-proxy-paths";
import { CONTEXT_PROXY_ROUTES } from "./agent-proxy-context-routes";
import { LOCAL_MEMORY_PROXY_ROUTE, TEAM_MEMORY_PROXY_ROUTE } from "./agent-proxy-memory-routes";
import { PROC_PROXY_ROUTES } from "./agent-proxy-proc-routes";

export const LOCAL_QUERY_PROXY_ROUTES: readonly ProxyRoute[] = [
  LOCAL_MEMORY_PROXY_ROUTE,
  TEAM_MEMORY_PROXY_ROUTE,
  ...PROC_PROXY_ROUTES,
  defineRoute({
    family: "agent-api/version",
    method: agentApiRoutes.proxy.version.method,
    match: exactPath(agentApiRoutes.proxy.version.path),
    body: "none",
    handler: "version",
    parse: () => ({}),
  }),
  ...CONTEXT_PROXY_ROUTES,
  defineRoute({
    family: "agent-api/computer-update-notice",
    method: agentApiRoutes.proxy.computerUpdateNotice.method,
    match: exactPath(agentApiRoutes.proxy.computerUpdateNotice.path),
    body: "none",
    handler: "computerUpdateNotice",
    parse: () => ({}),
  }),
];
