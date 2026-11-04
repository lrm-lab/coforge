import {
  agentApiRoutes,
  decodeAgentAppRegistrationRequest,
  decodeAgentAppTokenBody,
} from "@lrm/coforge-sdk/agent";
import { badRequest } from "./agent-proxy-body";
import * as domain from "./agent-proxy-domain-failures";
import { exactPath, pathParam } from "./agent-proxy-paths";
import { decodePathParam, parseAppConfigUpdate } from "./agent-proxy-request-parsers";
import { forwardResponse } from "./agent-proxy-response";
import { defineRoute, type ProxyRoute } from "./agent-proxy-route";

/** The local proxy's App routes: an App's config, the App list, the Marketplace browse, an App
 * token and an App registration, in the order the proxy matches them. */

const LOCAL_PROXY_ROUTES = agentApiRoutes.proxy;
// An App's config is `<prefix><appId>/config`.
const APP_CONFIG_SUFFIX = "/config";
const LOCAL_APP_CONFIG_ROUTE_PREFIX = LOCAL_PROXY_ROUTES.appConfig.get
  .path("")
  .slice(0, -APP_CONFIG_SUFFIX.length);

export const APP_PROXY_ROUTES: readonly ProxyRoute[] = [
  defineRoute({
    family: "agent-api/app-config-get",
    method: LOCAL_PROXY_ROUTES.appConfig.get.method,
    match: pathParam(LOCAL_APP_CONFIG_ROUTE_PREFIX, APP_CONFIG_SUFFIX),
    body: "none",
    handler: "appConfigGet",
    parse: ({ param }) => {
      const appId = decodePathParam(param);
      return appId instanceof Response ? appId : { appId };
    },
    domainFailure: domain.appConfigDomainFailure,
  }),
  defineRoute({
    family: "agent-api/app-config-update",
    method: LOCAL_PROXY_ROUTES.appConfig.update.method,
    match: pathParam(LOCAL_APP_CONFIG_ROUTE_PREFIX, APP_CONFIG_SUFFIX),
    body: "json-object",
    handler: "appConfigUpdate",
    parse: ({ param, fields }) => parseAppConfigUpdate(param, fields),
    domainFailure: domain.appConfigDomainFailure,
  }),
  defineRoute({
    family: "agent-api/app-list",
    method: LOCAL_PROXY_ROUTES.apps.list.method,
    match: exactPath(LOCAL_PROXY_ROUTES.apps.list.path),
    body: "none",
    handler: "agentApp",
    parse: () => ({ operation: "list" as const }),
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/app-marketplace",
    method: LOCAL_PROXY_ROUTES.apps.marketplace.method,
    match: exactPath(LOCAL_PROXY_ROUTES.apps.marketplace.path),
    body: "none",
    handler: "agentApp",
    parse: ({ url }) => {
      const query = url.searchParams.get("query") ?? undefined;
      const raw = url.searchParams.get("limit");
      if (raw !== null && raw !== "" && !Number.isInteger(Number(raw))) return badRequest();
      const limit = raw === null || raw === "" ? undefined : Number(raw);
      return {
        operation: "marketplace" as const,
        ...(query === undefined ? {} : { query }),
        ...(limit === undefined ? {} : { limit }),
      };
    },
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/app-token",
    method: LOCAL_PROXY_ROUTES.apps.token.method,
    // The same `/api/agent/v1/apps/` prefix as an App's config.
    match: pathParam(LOCAL_APP_CONFIG_ROUTE_PREFIX, "/token"),
    body: "json-object",
    handler: "agentApp",
    parse: ({ param, fields }) => {
      const appKey = decodePathParam(param);
      const body = decodeAgentAppTokenBody(fields);
      if (appKey instanceof Response) return appKey;
      return body ? { operation: "token" as const, appKey, ...body } : badRequest();
    },
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/app-registration",
    method: LOCAL_PROXY_ROUTES.appRegistrations.method,
    match: exactPath(LOCAL_PROXY_ROUTES.appRegistrations.path),
    body: "json-object",
    maxBodyBytes: LOCAL_PROXY_ROUTES.appRegistrations.maxBodyBytes,
    handler: "agentApp",
    parse: ({ fields }) => decodeAgentAppRegistrationRequest(fields) ?? badRequest(),
    respond: forwardResponse,
  }),
];
