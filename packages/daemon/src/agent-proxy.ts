import { badRequest, MAX_BODY_BYTES, readJsonBody } from "./agent-proxy-body";
import {
  createCollabProxyDispatcher,
  type AgentProxyCloudForward,
} from "./agent-proxy-collab-routes";
import { guardDelivery } from "./agent-proxy-delivery";
import { exactPath, pathParam } from "./agent-proxy-paths";
import {
  encodeLocalReminderRequest,
  validateTaskRequest,
  validateWeeklyReportRequest,
  type LocalReminderRequest,
  type TaskCommand,
  type WeeklyReportCommand,
  MESSAGE_ANCHOR_SOURCE,
  UUID_LIKE_SOURCE,
  isRecord,
} from "@lrm/coforge-sdk/internal";
import { agentApiRoutes, decodeAgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { isAgentApiKey } from "#src/credentials/agent-api-key";
import {
  parseActionPrepareRequest,
  parseChannelCommand,
  parseGithubCommitTrailersRequest,
  parseGithubCredentialRequest,
  parseMentionExecuteFields,
  parseProfileUpdateFields,
  decodePathParam,
  parseInboxListQuery,
  parseInboxRequest,
  parseMentionPendingLimit,
} from "./agent-proxy-request-parsers";
import { forwardResponse, proxyFailureResponse } from "./agent-proxy-response";
import * as domain from "./agent-proxy-domain-failures";
import { validateWeeklyReportCollectCommand } from "#src/connection/weekly-report-collect";
import { validateWeeklyReportKeyPointsCommand } from "#src/connection/weekly-report-key-points";
import { validateWeeklyReportMemoryCommand } from "#src/connection/weekly-report-memory";
import { getLogger } from "@logtape/logtape";
import { parseMessageRequest } from "./agent-proxy-message-request";
import { TASK_CONVERSATION_PROXY_ROUTES } from "./agent-proxy-task-routes";
import { APP_PROXY_ROUTES } from "./agent-proxy-app-routes";
import { ARTIFACT_FILE_PROXY_ROUTES } from "./agent-proxy-artifact-routes";
import { ATTACHMENT_PROXY_ROUTES } from "./agent-proxy-attachment-routes";
import { LABEL_PROXY_ROUTES } from "./agent-proxy-label-routes";
import { LOCAL_QUERY_PROXY_ROUTES } from "./agent-proxy-local-query-routes";
export type AgentProxy = {
  url: string;
  issue(agentId: string, agentApiKey: string): string;
  revoke(token: string): void;
  close(): void;
};
import type { AgentProxyRuntime } from "./agent-proxy-runtime";
import {
  defineRoute,
  findProxyRoute,
  operationFamily,
  parseRouteRequest,
  type JsonObject,
  type ProxyRoute,
  type TokenBinding,
} from "./agent-proxy-route";
import { AgentProxyTokens } from "./agent-proxy-tokens";
const LOCAL_PROXY_TOKEN = /^sfp_[A-Za-z0-9_-]{43}$/;
const MESSAGE_ID_ANCHOR = new RegExp(`^(?:${MESSAGE_ANCHOR_SOURCE}|${UUID_LIKE_SOURCE})$`, "i");
const LOCAL_PROXY_ROUTES = agentApiRoutes.proxy;
const LOCAL_USER_ROUTE_PREFIX = LOCAL_PROXY_ROUTES.users.path("");
const MENTION_DELIVERY_SUFFIX = "/mention-deliveries";
const LOCAL_MENTION_DELIVERY_ROUTE_PREFIX = LOCAL_PROXY_ROUTES.mentionDeliveries
  .path("")
  .slice(0, -MENTION_DELIVERY_SUFFIX.length);
const WEEKLY_REPORT_COLLECT_MAX_BODY_BYTES = 512 * 1024;
const logger = getLogger(["coforge", "daemon", "agent-proxy"]);
const ROUTE_TABLE: readonly ProxyRoute[] = [
  defineRoute({
    family: "agent-api/workspace-info",
    method: LOCAL_PROXY_ROUTES.workspace.method,
    match: exactPath(LOCAL_PROXY_ROUTES.workspace.path),
    body: "none",
    handler: "workspaceInfo",
    parse: () => ({ idempotencyKey: crypto.randomUUID() }),
  }),
  defineRoute({
    family: "agent-api/manual-get",
    method: LOCAL_PROXY_ROUTES.manual.get.method,
    match: exactPath(LOCAL_PROXY_ROUTES.manual.get.path),
    body: "none",
    handler: "manualGet",
    parse: ({ url }) => ({
      topic: url.searchParams.get("topic") ?? "",
      intent: url.searchParams.get("intent") ?? "",
      reason: url.searchParams.get("reason") ?? "",
    }),
    domainFailure: domain.manualDomainFailure,
  }),
  defineRoute({
    family: "agent-api/manual-search",
    method: LOCAL_PROXY_ROUTES.manual.search.method,
    match: exactPath(LOCAL_PROXY_ROUTES.manual.search.path),
    body: "none",
    handler: "manualSearch",
    parse: ({ url }) => ({
      query: url.searchParams.get("query") ?? "",
      intent: url.searchParams.get("intent") ?? "",
      reason: url.searchParams.get("reason") ?? "",
    }),
    domainFailure: domain.manualDomainFailure,
  }),
  ...LOCAL_QUERY_PROXY_ROUTES,
  defineRoute({
    family: "agent-api/user-info",
    method: LOCAL_PROXY_ROUTES.users.method,
    match: pathParam(LOCAL_USER_ROUTE_PREFIX),
    body: "none",
    handler: "userInfo",
    parse: ({ param }) => {
      const name = decodePathParam(param);
      return name instanceof Response ? name : { name };
    },
    domainFailure: domain.userInfoDomainFailure,
  }),
  defineRoute({
    family: "agent-api/profile-show",
    method: LOCAL_PROXY_ROUTES.profile.get.method,
    match: exactPath(LOCAL_PROXY_ROUTES.profile.get.path),
    body: "none",
    handler: "profileShow",
    parse: ({ url }) => ({ target: url.searchParams.get("target") ?? undefined }),
    domainFailure: domain.profileDomainFailure,
  }),
  defineRoute({
    family: "agent-api/profile-update",
    method: LOCAL_PROXY_ROUTES.profile.update.method,
    match: exactPath(LOCAL_PROXY_ROUTES.profile.update.path),
    body: "json-object",
    handler: "profileUpdate",
    parse: ({ fields }) => parseProfileUpdateFields(fields),
    domainFailure: domain.profileDomainFailure,
  }),
  ...APP_PROXY_ROUTES,
  defineRoute({
    family: "agent-api/artifact",
    method: LOCAL_PROXY_ROUTES.artifacts.method,
    match: exactPath(LOCAL_PROXY_ROUTES.artifacts.path),
    body: "json-object",
    maxBodyBytes: LOCAL_PROXY_ROUTES.artifacts.maxBodyBytes,
    handler: "agentArtifact",
    parse: ({ fields }) => decodeAgentArtifactRequest(fields) ?? badRequest(),
    respond: forwardResponse,
  }),
  ...ARTIFACT_FILE_PROXY_ROUTES,
  defineRoute({
    family: "agent-api/inbox-list",
    method: LOCAL_PROXY_ROUTES.inboxList.method,
    match: exactPath(LOCAL_PROXY_ROUTES.inboxList.path),
    body: "none",
    handler: "inboxList",
    parse: ({ url }) => parseInboxListQuery(url.searchParams),
  }),
  defineRoute({
    family: "agent-api/thread-list",
    method: LOCAL_PROXY_ROUTES.threadList.method,
    match: exactPath(LOCAL_PROXY_ROUTES.threadList.path),
    body: "none",
    handler: "threadList",
    parse: () => ({}),
  }),
  ...LABEL_PROXY_ROUTES,
  defineRoute({
    family: "agent-api/mention-pending",
    method: LOCAL_PROXY_ROUTES.mentionActions.pending.method,
    match: exactPath(LOCAL_PROXY_ROUTES.mentionActions.pending.path),
    body: "none",
    handler: "mentionPending",
    parse: ({ url }) => parseMentionPendingLimit(url.searchParams.get("limit")),
    domainFailure: domain.mentionActionDomainFailure,
  }),
  defineRoute({
    family: "agent-api/mention-execute",
    method: LOCAL_PROXY_ROUTES.mentionActions.execute.method,
    match: exactPath(LOCAL_PROXY_ROUTES.mentionActions.execute.path),
    body: "json-object",
    handler: "mentionExecute",
    parse: ({ fields }) => parseMentionExecuteFields(fields),
    domainFailure: domain.mentionActionDomainFailure,
  }),
  defineRoute({
    family: "agent-api/mention-delivery",
    method: LOCAL_PROXY_ROUTES.mentionDeliveries.method,
    match: pathParam(LOCAL_MENTION_DELIVERY_ROUTE_PREFIX, MENTION_DELIVERY_SUFFIX),
    body: "none",
    handler: "mentionDelivery",
    parse: ({ param }) => {
      const messageId = decodePathParam(param);
      if (messageId instanceof Response) return messageId;
      return MESSAGE_ID_ANCHOR.test(messageId) ? { messageId } : badRequest();
    },
    domainFailure: domain.mentionDeliveryDomainFailure,
  }),
  ...ATTACHMENT_PROXY_ROUTES,
  defineRoute({
    family: "agent-api/reminder",
    method: LOCAL_PROXY_ROUTES.reminders.method,
    match: exactPath(LOCAL_PROXY_ROUTES.reminders.path),
    body: "json-object",
    handler: "reminder",
    parse: ({ fields, binding }) => {
      const local = { ...fields, context: binding.context } as LocalReminderRequest;
      encodeLocalReminderRequest(local);
      return local;
    },
  }),
  defineRoute({
    family: "agent-api/task",
    method: LOCAL_PROXY_ROUTES.tasks.method,
    match: exactPath(LOCAL_PROXY_ROUTES.tasks.path),
    body: "json-object",
    handler: "agentTask",
    parse: ({ fields }) => {
      const command = fields as TaskCommand;
      validateTaskRequest(command);
      return command;
    },
  }),
  defineRoute({
    family: operationFamily("agent-api/channel-", "unknown"),
    method: LOCAL_PROXY_ROUTES.channels.method,
    match: exactPath(LOCAL_PROXY_ROUTES.channels.path),
    body: "json-object",
    handler: "agentChannel",
    parse: ({ fields }) => parseChannelCommand(fields),
  }),
  defineRoute({
    family: "agent-api/action-prepare",
    method: LOCAL_PROXY_ROUTES.actionPrepare.method,
    match: exactPath(LOCAL_PROXY_ROUTES.actionPrepare.path),
    body: "json-object",
    handler: "agentActionPrepare",
    parse: ({ fields }) => parseActionPrepareRequest(fields),
  }),
  defineRoute({
    family: "agent-api/weekly-report",
    method: LOCAL_PROXY_ROUTES.weeklyReports.method,
    match: exactPath(LOCAL_PROXY_ROUTES.weeklyReports.path),
    body: "json-object",
    handler: "agentWeeklyReport",
    parse: ({ fields, binding }) => {
      const command = fields as WeeklyReportCommand;
      validateWeeklyReportRequest({
        ...command,
        idempotencyKey: "local",
        workspaceId: "local",
        agentId: binding.agentId,
      });
      return command;
    },
  }),
  defineRoute({
    family: "agent-api/weekly-report-collect",
    method: LOCAL_PROXY_ROUTES.weeklyReportCollect.method,
    match: exactPath(LOCAL_PROXY_ROUTES.weeklyReportCollect.path),
    body: "json-object",
    maxBodyBytes: WEEKLY_REPORT_COLLECT_MAX_BODY_BYTES,
    handler: "agentWeeklyReportCollect",
    parse: ({ fields }) => validateWeeklyReportCollectCommand(fields) ?? badRequest(),
  }),
  defineRoute({
    family: "agent-api/weekly-report-key-points",
    method: LOCAL_PROXY_ROUTES.weeklyReportKeyPoints.method,
    match: exactPath(LOCAL_PROXY_ROUTES.weeklyReportKeyPoints.path),
    body: "json-object",
    maxBodyBytes: WEEKLY_REPORT_COLLECT_MAX_BODY_BYTES,
    handler: "agentWeeklyReportKeyPoints",
    parse: ({ fields }) => validateWeeklyReportKeyPointsCommand(fields) ?? badRequest(),
  }),
  defineRoute({
    family: "agent-api/weekly-report-memory",
    method: LOCAL_PROXY_ROUTES.weeklyReportMemory.method,
    match: exactPath(LOCAL_PROXY_ROUTES.weeklyReportMemory.path),
    body: "json-object",
    maxBodyBytes: WEEKLY_REPORT_COLLECT_MAX_BODY_BYTES,
    handler: "agentWeeklyReportMemory",
    parse: ({ fields }) => validateWeeklyReportMemoryCommand(fields) ?? badRequest(),
  }),
  defineRoute({
    family: "agent-api/github-credential",
    method: LOCAL_PROXY_ROUTES.githubCredentials.method,
    match: exactPath(LOCAL_PROXY_ROUTES.githubCredentials.path),
    body: "json-object",
    handler: "githubCredential",
    parse: ({ fields }) => parseGithubCredentialRequest(fields),
    respond: (result) => Response.json(result, { headers: { "cache-control": "no-store" } }),
  }),
  defineRoute({
    family: "agent-api/github-commit-trailers",
    method: LOCAL_PROXY_ROUTES.githubCommitTrailers.method,
    match: exactPath(LOCAL_PROXY_ROUTES.githubCommitTrailers.path),
    body: "json-object",
    handler: "githubCommitTrailers",
    parse: ({ fields }) => parseGithubCommitTrailersRequest(fields),
    respond: (result) => Response.json(result, { headers: { "cache-control": "no-store" } }),
  }),
  defineRoute({
    family: "agent-api/inbox",
    method: LOCAL_PROXY_ROUTES.inbox.method,
    match: exactPath(LOCAL_PROXY_ROUTES.inbox.path),
    body: "json-object",
    handler: "inbox",
    parse: ({ fields, binding }) => parseInboxRequest(fields, binding.context),
  }),
  defineRoute({
    family: operationFamily("agent-api/", "message"),
    method: LOCAL_PROXY_ROUTES.messages.method,
    match: exactPath(LOCAL_PROXY_ROUTES.messages.path),
    body: "json-object",
    handler: "agentMessage",
    parse: ({ fields, binding }) => parseMessageRequest(fields, binding),
  }),
  ...TASK_CONVERSATION_PROXY_ROUTES,
];
export function startAgentProxy(input: {
  onRequest?: (request: { method: string; path: string }) => void;
  runtime: AgentProxyRuntime;
  agentApiKeys?: {
    get(agentId: string): string | undefined;
    set(agentId: string, agentApiKey: string): void;
  };
  stateDirectory?: string;
  reportsCompaction?: (agentId: string) => boolean;
  cloudForward?: AgentProxyCloudForward;
  port?: number;
}): AgentProxy {
  const tokens = new AgentProxyTokens();
  const agentApiKeys = input.agentApiKeys ?? new Map<string, string>();
  const collab = createCollabProxyDispatcher({
    agentApiKeys,
    runtime: input.runtime,
    stateDirectory: input.stateDirectory,
    reportsCompaction: input.reportsCompaction,
    cloudForward: input.cloudForward,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.port ?? 0,
    async fetch(request) {
      const requestUrl = new URL(request.url);
      input.onRequest?.({ method: request.method, path: requestUrl.pathname });
      logger.info("Agent proxy request", {
        event: "agent.proxy.request",
        method: request.method,
        path: requestUrl.pathname,
      });
      const candidate = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
      const token = candidate && LOCAL_PROXY_TOKEN.test(candidate) ? candidate : undefined;
      const registered = tokens.find(token);
      const direct = await collab.dispatchDirect(request, requestUrl, registered);
      if (direct) return direct;
      const found = findProxyRoute(ROUTE_TABLE, request.method, requestUrl.pathname);
      if (!found) return new Response("not found", { status: 404 });
      const { route, param } = found;
      if (!registered) return new Response("unauthorized", { status: 401 });
      const binding: TokenBinding = { ...registered };
      const handler = input.runtime[route.handler] as
        | ((context: string, request: unknown, agentApiKey: string | undefined) => Promise<unknown>)
        | undefined;
      if (!handler) return new Response("not found", { status: 404 });
      let fields: JsonObject = {};
      let redact = false;
      try {
        let payload: unknown;
        if (route.body !== "none") {
          if (
            route.body === "json-object" &&
            request.headers.get("content-type")?.toLowerCase() !== "application/json"
          )
            return new Response("unsupported media type", { status: 415 });
          const body = await readJsonBody(request, route.maxBodyBytes ?? MAX_BODY_BYTES);
          if (body instanceof Response) return body;
          payload = body.payload;
          if (route.body === "json-object") {
            if (!isRecord(payload)) return badRequest();
            fields = payload;
            redact = fields.freshnessContextMode === "withheld";
            if (
              requestUrl.pathname === LOCAL_PROXY_ROUTES.messages.path &&
              fields.operation === "send" &&
              fields.discardDraft === true
            ) {
              return await collab.discardDraft(binding, fields);
            }
          }
        }
        const parsed = parseRouteRequest(route.parse, {
          request,
          url: requestUrl,
          param,
          payload,
          fields,
          binding,
        });
        if (parsed instanceof Response) return parsed;
        const result = await handler.call(
          input.runtime,
          binding.context,
          parsed,
          agentApiKeys.get(binding.agentId),
        );
        return guardDelivery(
          route.respond ? route.respond(result as never) : Response.json(result),
          result,
          request.signal,
        );
      } catch (error) {
        const domainFailure = route.domainFailure?.(error);
        if (domainFailure) return domainFailure;
        return proxyFailureResponse(error, {
          method: request.method,
          path: requestUrl.pathname,
          routeFamily: typeof route.family === "function" ? route.family(fields) : route.family,
          agentId: binding.agentId,
          redact,
        });
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}${LOCAL_PROXY_ROUTES.messages.path}`,
    issue(agentId, agentApiKey) {
      if (!isAgentApiKey(agentApiKey)) throw new Error("invalid Agent API key");
      const token = tokens.register(
        agentId,
        (issued) => input.runtime.issueAgentContext?.(agentId, issued) || issued,
      );
      agentApiKeys.set(agentId, agentApiKey);
      return token;
    },
    revoke(token) {
      tokens.revoke(token);
    },
    close() {
      server.stop(true);
      tokens.clear();
    },
  };
}
