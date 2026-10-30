import { randomBytes } from "node:crypto";
import { exactPath, pathParam } from "./agent-proxy-paths";
import {
  encodeLocalReminderRequest,
  validateTaskRequest,
  validateWeeklyReportRequest,
  type LocalReminderRequest,
  type TaskCommand,
  type WeeklyReportCommand,
  ATTACHMENT_MAX_BYTES,
  MESSAGE_ANCHOR_SOURCE,
  UUID_LIKE_SOURCE,
  isRecord,
  utf8Encoder,
} from "@lrm/coforge-sdk/internal";
import {
  agentApiRoutes,
  decodeAgentAppRegistrationRequest,
  decodeAgentAppTokenBody,
} from "@lrm/coforge-sdk/agent";
import { isAgentApiKey } from "#src/credentials/agent-api-key";
import {
  parseActionPrepareRequest,
  parseChannelCommand,
  parseGithubCommitTrailersRequest,
  parseGithubCredentialRequest,
  parseMentionExecuteFields,
  parseProfileUpdateFields,
  decodePathParam,
  parseAppConfigUpdate,
  parseAttachmentCommentsRequest,
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
import { admitOpenVikingControl, admitOpenVikingRead } from "./openviking-read-proxy";
import { parseMessageRequest } from "./agent-proxy-message-request";

export type AgentProxy = {
  url: string;
  issue(agentId: string, agentApiKey: string): string;
  revoke(token: string): void;
  close(): void;
};

import type { AgentProxyRuntime } from "./agent-proxy-runtime";

const LOCAL_PROXY_TOKEN = /^sfp_[A-Za-z0-9_-]{43}$/;
const MESSAGE_ID_ANCHOR = new RegExp(`^(?:${MESSAGE_ANCHOR_SOURCE}|${UUID_LIKE_SOURCE})$`, "i");
const LOCAL_ATTACHMENT_ROUTE_PREFIX = agentApiRoutes.local.attachments.path("");
const LOCAL_ATTACHMENT_UPLOAD_PATH = agentApiRoutes.local.attachments.upload.path;
// The cloud rejects attachments above `ATTACHMENT_MAX_BYTES`; the local upload hop allows that
// plus slack for multipart framing overhead (boundary markers, field headers), so a file the
// cloud accepts is never refused here. The base number is the SDK's shared fact, not a copy.
const ATTACHMENT_UPLOAD_MAX_BYTES = ATTACHMENT_MAX_BYTES + 64 * 1024;
// The four presigned-direct-upload session routes are plain JSON, so they reuse the
// JSON body path below rather than the multipart forwarding above. `create` is a fixed path;
// `complete`/`cancel`/`get` share a `/:uploadId[/complete]` prefix.
const LOCAL_UPLOAD_SESSION_CREATE_PATH = agentApiRoutes.local.attachmentUploadSessions.create.path;
const LOCAL_UPLOAD_SESSION_ROUTE_PREFIX =
  agentApiRoutes.local.attachmentUploadSessions.get.path("");
const UPLOAD_SESSION_COMPLETE_SUFFIX = "/complete";
const LOCAL_PROXY_ROUTES = agentApiRoutes.proxy;
const LOCAL_USER_ROUTE_PREFIX = LOCAL_PROXY_ROUTES.users.path("");
// Mention delivery is `<prefix><messageId>/mention-deliveries`; the prefix is what the route's
// own path puts before an empty id.
const ATTACHMENT_COMMENTS_SUFFIX = "/comments";
const MENTION_DELIVERY_SUFFIX = "/mention-deliveries";
const LOCAL_MENTION_DELIVERY_ROUTE_PREFIX = LOCAL_PROXY_ROUTES.mentionDeliveries
  .path("")
  .slice(0, -MENTION_DELIVERY_SUFFIX.length);
// An App's config is `<prefix><appId>/config`.
const APP_CONFIG_SUFFIX = "/config";
const LOCAL_APP_CONFIG_ROUTE_PREFIX = LOCAL_PROXY_ROUTES.appConfig.get
  .path("")
  .slice(0, -APP_CONFIG_SUFFIX.length);
const MAX_BODY_BYTES = 64 * 1024;
/** Covers `WEEKLY_REPORT_MARKDOWN_MAX_CHARS` plus JSON framing. A byte budget, so it is not the
 * same number as that character cap — see `internal/weekly-report-limits.ts`. */
const WEEKLY_REPORT_COLLECT_MAX_BODY_BYTES = 512 * 1024;
const logger = getLogger(["coforge", "daemon", "agent-proxy"]);

/** What a Local Proxy token stands for: the Agent, its runtime context and its Agent API key. */
type TokenBinding = {
  agentId: string;
  context: string;
  agentApiKey: string;
  memoryFence?: string;
};
type JsonObject = Record<string, unknown>;

/**
 * How the dispatcher reads the request body before `parse` runs.
 * - `none`: no body read (GET/DELETE, and the multipart upload, which streams `request` through).
 * - `json`: size-limited JSON of any shape, no content-type requirement (upload-session create).
 * - `json-object`: requires `content-type: application/json` (else 415) and a plain object (else
 *   400); `freshnessContextMode: "withheld"` on it turns on reviewer redaction.
 */
type BodyRead = "none" | "json" | "json-object";

/** The runtime methods a route can dispatch to; each takes `(context, request, agentApiKey)`. */
type HandlerName = Exclude<keyof AgentProxyRuntime, "issueAgentContext" | "memoryFence">;
type RuntimeHandler<K extends HandlerName> = NonNullable<AgentProxyRuntime[K]>;
type RequestOf<K extends HandlerName> = Parameters<RuntimeHandler<K>>[1];
type ResultOf<K extends HandlerName> = Awaited<ReturnType<RuntimeHandler<K>>>;

type ProxyRoute<K extends HandlerName = HandlerName> = {
  /** `route_family` on a classified failure; a function when it depends on `operation`. */
  family: string | ((fields: JsonObject) => string);
  method: string;
  /** The path param (or `""` when the route has none) if the pathname belongs to this route. Must
   * not throw: a param that needs decoding is decoded in `parse`. */
  match(pathname: string): string | undefined;
  body: BodyRead;
  /** Override the default JSON body size cap (Collect packs need a larger limit). */
  maxBodyBytes?: number;
  /** The runtime method this route calls. The dispatcher looks it up, answers 404 when the runtime
   * lacks it, and always calls it with the token-bound context and Agent API key. */
  handler: K;
  /** Validates and builds the runtime request. Return a Response to reject (400/413). May throw
   * validator errors — those are classified by the dispatcher like any other failure. */
  parse(input: {
    request: Request;
    url: URL;
    param: string;
    /** The parsed body of a `json` route. */
    payload: unknown;
    /** The parsed body of a `json-object` route; empty otherwise. */
    fields: JsonObject;
    binding: TokenBinding;
  }): RequestOf<K> | Response;
  /** Defaults to `Response.json(result)`. */
  respond?(result: ResultOf<K>): Response;
  /** A domain error this route answers itself instead of the classified proxy failure. */
  domainFailure?(error: unknown): Response | undefined;
};

/** Type-checks one route entry against its own runtime method while keeping the table homogeneous. */
function defineRoute<K extends HandlerName>(route: ProxyRoute<K>): ProxyRoute {
  return route as unknown as ProxyRoute;
}

const badRequest = () => new Response("bad request", { status: 400 });
const payloadTooLarge = () => new Response("payload too large", { status: 413 });

/** A declared `content-length` that is malformed or over `maxBytes` (or absent, when required). */
function contentLengthRejected(request: Request, maxBytes: number, required: boolean): boolean {
  const contentLength = request.headers.get("content-length");
  if (!contentLength) return required;
  return !/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes;
}

/**
 * The shared size-limited JSON body read: an oversized or malformed `content-length` is `413` up
 * front; otherwise the body is read and re-measured (a caller can omit or lie about
 * `content-length`), and malformed JSON is a `400` — this is the one place a `SyntaxError` becomes
 * a bare `400`; one thrown later, by a route's `parse` or by the runtime, is classified.
 */
async function readJsonBody(
  request: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<{ payload: unknown } | Response> {
  if (contentLengthRejected(request, maxBytes, false)) return payloadTooLarge();
  const raw = await request.text();
  if (utf8Encoder.encode(raw).byteLength > maxBytes) return payloadTooLarge();
  try {
    return { payload: JSON.parse(raw) };
  } catch {
    return badRequest();
  }
}

/** A family that names the payload's `operation`, e.g. `agent-api/channel-info`. */
function operationFamily(prefix: string, fallback: string) {
  return (fields: JsonObject) =>
    `${prefix}${typeof fields.operation === "string" ? fields.operation : fallback}`;
}

/** The local Agent proxy's routes. Looking up the runtime method, passing context/key, the missing-
 * handler 404, response wrapping and failure classification are written exactly once, in the
 * dispatcher below — a route entry cannot forget any of them. */
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
  defineRoute({
    family: "agent-api/version",
    method: LOCAL_PROXY_ROUTES.version.method,
    match: exactPath(LOCAL_PROXY_ROUTES.version.path),
    body: "none",
    handler: "version",
    parse: () => ({}),
  }),
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
  defineRoute({
    family: "agent-api/attachment-comments",
    method: LOCAL_PROXY_ROUTES.attachmentComments.method,
    // Ahead of the attachment's own route, whose prefix match takes any rest of the path as an id.
    match: pathParam(LOCAL_ATTACHMENT_ROUTE_PREFIX, ATTACHMENT_COMMENTS_SUFFIX),
    body: "none",
    handler: "attachmentComments",
    parse: ({ param, url }) => parseAttachmentCommentsRequest(param, url.searchParams),
    domainFailure: domain.attachmentCommentsDomainFailure,
  }),
  defineRoute({
    family: "agent-api/attachment",
    method: "GET",
    match: pathParam(LOCAL_ATTACHMENT_ROUTE_PREFIX),
    body: "none",
    handler: "agentAttachment",
    parse: ({ param }) => decodePathParam(param),
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/attachment-upload",
    method: "POST",
    match: exactPath(LOCAL_ATTACHMENT_UPLOAD_PATH),
    body: "none",
    handler: "agentAttachmentUpload",
    parse: ({ request }) =>
      contentLengthRejected(request, ATTACHMENT_UPLOAD_MAX_BYTES, true)
        ? payloadTooLarge()
        : request,
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/attachment-upload-session-create",
    method: "POST",
    match: exactPath(LOCAL_UPLOAD_SESSION_CREATE_PATH),
    body: "json",
    handler: "agentAttachmentUploadSessionCreate",
    parse: ({ payload }) => payload,
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/attachment-upload-session-complete",
    method: "POST",
    match: pathParam(LOCAL_UPLOAD_SESSION_ROUTE_PREFIX, UPLOAD_SESSION_COMPLETE_SUFFIX),
    body: "none",
    handler: "agentAttachmentUploadSessionComplete",
    parse: ({ param }) => decodePathParam(param),
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/attachment-upload-session-get",
    method: "GET",
    match: pathParam(LOCAL_UPLOAD_SESSION_ROUTE_PREFIX),
    body: "none",
    handler: "agentAttachmentUploadSessionGet",
    parse: ({ param }) => decodePathParam(param),
    respond: forwardResponse,
  }),
  defineRoute({
    family: "agent-api/attachment-upload-session-cancel",
    method: "DELETE",
    match: pathParam(LOCAL_UPLOAD_SESSION_ROUTE_PREFIX),
    body: "none",
    handler: "agentAttachmentUploadSessionCancel",
    parse: ({ param }) => decodePathParam(param),
    respond: forwardResponse,
  }),
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
    family: "agent-api/memory-disposition",
    method: LOCAL_PROXY_ROUTES.memoryDisposition.method,
    match: exactPath(LOCAL_PROXY_ROUTES.memoryDisposition.path),
    body: "json-object",
    handler: "agentMemoryDisposition",
    parse: ({ fields, binding }) =>
      binding.memoryFence ? Response.json({ ok: false, error: { code: "unauthorized" } }) : fields,
  }),
  defineRoute({
    family: "agent-api/openviking",
    method: LOCAL_PROXY_ROUTES.openviking.method,
    match: exactPath(LOCAL_PROXY_ROUTES.openviking.path),
    body: "json-object",
    handler: "agentOpenviking",
    parse: ({ fields, binding }) => {
      const admitted =
        fields.op === "offer" || fields.op === "diagnose"
          ? admitOpenVikingControl({ body: fields, fence: binding.memoryFence })
          : admitOpenVikingRead({ body: fields, fence: binding.memoryFence });
      return admitted.ok
        ? admitted.command
        : Response.json(admitted.body, { status: admitted.status });
    },
    domainFailure: domain.openvikingDomainFailure,
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
];

/** The first route whose method and pathname match, along with the path param `match` found. */
function findRoute(
  method: string,
  pathname: string,
): { route: ProxyRoute; param: string } | undefined {
  for (const route of ROUTE_TABLE) {
    if (route.method !== method) continue;
    const param = route.match(pathname);
    if (param !== undefined) return { route, param };
  }
  return undefined;
}

/** One daemon-local HTTP boundary shared by all Agent child processes. */
export function startAgentProxy(input: {
  onRequest?: (request: { method: string; path: string }) => void;
  runtime: AgentProxyRuntime;
  port?: number;
}): AgentProxy {
  // This is deliberately a daemon-local Proxy token, not a cloud API key.
  // Its lifetime is bounded by the Agent process registration and it is
  // revoked when that registration stops. Keeping it stable means a long-idle
  // Agent can make its first request without receiving a new environment
  // variable or running a refresh command.
  const contexts = new Map<string, TokenBinding>();
  const server = Bun.serve({
    // Loopback only: Agents reach the proxy at 127.0.0.1 (see `url` below). Bun's default
    // `0.0.0.0` would expose it to the network and let another local listener bind
    // 127.0.0.1 on the same port and receive the Agents' requests instead.
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

      const found = findRoute(request.method, requestUrl.pathname);
      if (!found) return new Response("not found", { status: 404 });
      const { route, param } = found;

      const authorization = request.headers.get("authorization");
      const candidate = authorization?.match(/^Bearer (.+)$/)?.[1];
      const token = candidate && LOCAL_PROXY_TOKEN.test(candidate) ? candidate : undefined;
      const registered = token ? contexts.get(token) : undefined;
      if (!registered) return new Response("unauthorized", { status: 401 });
      const binding: TokenBinding = {
        ...registered,
        memoryFence: input.runtime.memoryFence?.(registered.agentId),
      };

      // `inbox` declares no key parameter; every other runtime method takes all three.
      const handler = input.runtime[route.handler] as
        | ((context: string, request: unknown, agentApiKey: string) => Promise<unknown>)
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
          }
        }
        const parsed = route.parse({ request, url: requestUrl, param, payload, fields, binding });
        if (parsed instanceof Response) return parsed;
        // Identity is exclusively the token binding, and the Agent API key stays in this trusted
        // registration: neither is ever read from, or serialized into, the child's request.
        const result = await handler.call(
          input.runtime,
          binding.context,
          parsed,
          binding.agentApiKey,
        );
        return route.respond ? route.respond(result as never) : Response.json(result);
      } catch (error) {
        const domainFailure = route.domainFailure?.(error);
        if (domainFailure) return domainFailure;
        // Every other failure is classified: never a bare, unlabeled 502. Reviewer-isolated
        // requests still get a classified response, but with detail withheld.
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
      const token = `sfp_${randomBytes(32).toString("base64url")}`;
      const context = input.runtime.issueAgentContext?.(agentId, token) || token;
      contexts.set(token, { agentId, context, agentApiKey });
      return token;
    },
    revoke(token) {
      contexts.delete(token);
    },
    close() {
      server.stop(true);
      contexts.clear();
    },
  };
}
