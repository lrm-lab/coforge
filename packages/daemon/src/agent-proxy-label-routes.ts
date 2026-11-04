import { agentApiRoutes, decodeAgentLabelWriteRequest } from "@lrm/coforge-sdk/agent";
import { badRequest } from "./agent-proxy-body";
import { exactPath } from "./agent-proxy-paths";
import { forwardResponse } from "./agent-proxy-response";
import { defineRoute, type ProxyRoute } from "./agent-proxy-route";

const LOCAL_PROXY_ROUTES = agentApiRoutes.proxy;

/** The local proxy's label routes: `coforge label list` reads the Workspace's labels, and
 * `coforge label create|rename|update|delete|restore` (task #508) writes one, forwarded as it is
 * once the body is one label write. */
export const LABEL_PROXY_ROUTES: readonly ProxyRoute[] = [
  defineRoute({
    family: "agent-api/labels",
    method: LOCAL_PROXY_ROUTES.labels.method,
    match: exactPath(LOCAL_PROXY_ROUTES.labels.path),
    body: "none",
    handler: "labelList",
    parse: () => ({}),
  }),
  defineRoute({
    family: "agent-api/label-write",
    method: LOCAL_PROXY_ROUTES.labelWrite.method,
    match: exactPath(LOCAL_PROXY_ROUTES.labelWrite.path),
    body: "json-object",
    handler: "agentLabel",
    parse: ({ fields }) => decodeAgentLabelWriteRequest(fields) ?? badRequest(),
    respond: forwardResponse,
  }),
];
