import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { isChannelMessageTarget, isChannelTarget, isRecord } from "@lrm/coforge-sdk/internal";
import {
  agentHeaders,
  assertAgentResponseOk,
  fetchAgentResponse,
  readAgentResponseJson,
} from "#src/connection/agent-http-wire";
import { FileDaemonCredentialStore } from "#src/credentials/credential-store";
import { daemonStartupOptions } from "#src/daemon-startup-options";
import { AgentPreflightError } from "#src/daemon-runtime/agent-preflight-error";
import { evaluateAgentCommandGuidance } from "#src/persistence/agent-context-ledger";
import { AgentMessageDraftStore } from "#src/persistence/agent-message-draft-store";
import { AgentStateDb } from "#src/persistence/agent-state-db";
import { DaemonConfigStore } from "#src/persistence/daemon-config";
import { escapePathIdentity } from "#src/persistence/path-scope";
import { badRequest, MAX_BODY_BYTES, readJsonBody } from "./agent-proxy-body";
import { pathParam } from "./agent-proxy-paths";
import { decodePathParam } from "./agent-proxy-request-parsers";
import { proxyFailureResponse } from "./agent-proxy-response";
import type { TokenBinding } from "./agent-proxy-route";
import type { AgentProxyRuntime } from "./agent-proxy-runtime";

const LOCAL_PROXY_ROUTES = agentApiRoutes.proxy;
const THREAD_FOLLOW_SUFFIX = "/follow";
const LOCAL_THREAD_FOLLOW_PREFIX = LOCAL_PROXY_ROUTES.threadFollow
  .path("")
  .slice(0, -THREAD_FOLLOW_SUFFIX.length);

export type AgentProxyCloudForward = {
  serverHttpUrl: string | (() => string | undefined);
  daemonApiKey: () => Promise<string | null>;
};

export function createCollabProxyDispatcher(input: {
  agentApiKeys: { get(agentId: string): string | undefined };
  runtime?: AgentProxyRuntime;
  stateDirectory?: string;
  reportsCompaction?: (agentId: string) => boolean;
  cloudForward?: AgentProxyCloudForward;
}) {
  let defaultStateDir: string | undefined;
  let cachedConfigStore: { dir: string; store: DaemonConfigStore } | undefined;
  let cachedCredStore: FileDaemonCredentialStore | undefined;

  const resolveStateDir = () => {
    if (input.stateDirectory) return input.stateDirectory;
    const fromRuntime = input.runtime?.collab?.stateDirectory();
    if (fromRuntime) return fromRuntime;
    defaultStateDir ??= daemonStartupOptions(process.argv.slice(2)).daemonStateDirectory;
    return defaultStateDir;
  };

  const authorize = (binding: TokenBinding): string | undefined => {
    const apiKey = input.agentApiKeys.get(binding.agentId);
    input.runtime?.collab?.authorize(binding.context, apiKey);
    return apiKey;
  };

  const resolveCloud = async (agentId: string) => {
    const agentApiKey = input.agentApiKeys.get(agentId);
    if (!agentApiKey) return null;
    if (input.cloudForward) {
      const serverHttpUrl =
        typeof input.cloudForward.serverHttpUrl === "function"
          ? input.cloudForward.serverHttpUrl()
          : input.cloudForward.serverHttpUrl;
      if (!serverHttpUrl) return null;
      const daemonApiKey = await input.cloudForward.daemonApiKey();
      return daemonApiKey ? { agentApiKey, serverHttpUrl, daemonApiKey } : null;
    }
    const dir = resolveStateDir();
    if (!cachedConfigStore || cachedConfigStore.dir !== dir) {
      cachedConfigStore = {
        dir,
        store: new DaemonConfigStore(dir, {
          serverHttpUrl: Bun.env.COFORGE_DAEMON_SERVER_URL,
        }),
      };
    }
    const cfg = await cachedConfigStore.store.load();
    if (!cfg?.serverHttpUrl) return null;
    cachedCredStore ??= new FileDaemonCredentialStore();
    const daemonApiKey = await cachedCredStore.load(cfg.workspaceId, cfg.computerId);
    return daemonApiKey ? { agentApiKey, serverHttpUrl: cfg.serverHttpUrl, daemonApiKey } : null;
  };

  const forwardCloudData = async (
    agentId: string,
    method: "GET" | "POST",
    path: string,
    what: string,
    options: { query?: URLSearchParams; body?: unknown } = {},
  ): Promise<unknown | Response> => {
    const cloud = await resolveCloud(agentId);
    if (!cloud) return new Response("not found", { status: 404 });
    const url = new URL(path, cloud.serverHttpUrl);
    if (options.query) url.search = options.query.toString();
    const hasBody = options.body !== undefined;
    const res = await fetchAgentResponse(
      fetch,
      url,
      {
        method,
        headers: agentHeaders(cloud, hasBody),
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(10_000),
      },
      what,
    );
    await assertAgentResponseOk(res, what);
    return readAgentResponseJson(res, what);
  };

  const forwardCloudJson = async (
    agentId: string,
    method: "GET" | "POST",
    path: string,
    what: string,
    options: { query?: URLSearchParams; body?: unknown } = {},
  ): Promise<Response> => {
    const data = await forwardCloudData(agentId, method, path, what, options);
    return data instanceof Response ? data : Response.json(data);
  };

  const discardDraft = async (
    binding: TokenBinding,
    payload: Record<string, unknown>,
  ): Promise<Response> => {
    const rawTarget = typeof payload.target === "string" ? payload.target.trim() : "";
    const expected = payload.expectedDraftKey;
    if (
      !rawTarget ||
      payload.sendDraft === true ||
      payload.continueAnyway === true ||
      payload.content !== undefined ||
      (expected !== undefined && (typeof expected !== "string" || !expected.trim()))
    )
      return badRequest();
    const apiKey = authorize(binding);
    const target =
      input.runtime?.collab && apiKey
        ? await input.runtime.collab.canonicalizeTarget(binding.context, rawTarget, apiKey)
        : rawTarget;
    if (input.runtime?.collab && apiKey) authorize(binding);
    const idempotencyKey =
      typeof payload.idempotencyKey === "string" && payload.idempotencyKey
        ? payload.idempotencyKey
        : crypto.randomUUID();
    const borrowedDb = input.runtime?.collab?.stateDb?.(binding.agentId);
    const stateDirectory = borrowedDb ? "" : resolveStateDir();
    if (!borrowedDb) {
      const hasDb =
        Boolean(input.stateDirectory || input.runtime?.collab) ||
        existsSync(
          join(stateDirectory, "agent-state", escapePathIdentity(binding.agentId), "state.db"),
        );
      if (!hasDb) {
        return Response.json({
          idempotencyKey,
          accepted: true,
          clearedDraft: false,
          discarded: false,
          target,
        });
      }
    }
    const stateDb = borrowedDb ?? AgentStateDb.open(stateDirectory, binding.agentId);
    try {
      const store = new AgentMessageDraftStore(stateDb);
      const result = store.discard(target, typeof expected === "string" ? expected : undefined);
      if (result.status === "missing") {
        return Response.json({
          idempotencyKey,
          accepted: true,
          clearedDraft: false,
          discarded: false,
          target,
        });
      }
      if (result.status === "mismatch") {
        throw new AgentPreflightError(
          "The saved draft no longer matches the expected idempotency key. No request was made and the current draft was left unchanged because it belongs to a different logical send.",
          "SAVED_DRAFT_IDENTITY_CHANGED",
          { draftSaved: false, retryable: false },
        );
      }
      return Response.json({
        idempotencyKey,
        accepted: true,
        clearedDraft: true,
        discarded: true,
        discardedDraftKey: result.idempotencyKey,
        target,
      });
    } finally {
      if (!borrowedDb) stateDb.close();
    }
  };

  const dispatchDirect = async (
    request: Request,
    requestUrl: URL,
    registered: TokenBinding | undefined,
  ): Promise<Response | undefined> => {
    const threadParam =
      request.method === LOCAL_PROXY_ROUTES.threadFollow.method
        ? pathParam(LOCAL_THREAD_FOLLOW_PREFIX, THREAD_FOLLOW_SUFFIX)(requestUrl.pathname)
        : undefined;
    if (threadParam !== undefined) {
      if (!registered) return new Response("unauthorized", { status: 401 });
      const thread = decodePathParam(threadParam);
      if (thread instanceof Response) return thread;
      if (!isChannelMessageTarget(thread) || isChannelTarget(thread)) return badRequest();
      try {
        authorize(registered);
        const parsed =
          request.headers.get("content-length") === "0"
            ? undefined
            : await readJsonBody(request, MAX_BODY_BYTES);
        const payload =
          !(parsed instanceof Response) && isRecord(parsed?.payload) ? parsed.payload : {};
        return await forwardCloudJson(
          registered.agentId,
          "POST",
          agentApiRoutes.cloud.threads.follow.path(thread),
          "Agent thread follow",
          { body: { idempotencyKey: payload.idempotencyKey ?? crypto.randomUUID() } },
        );
      } catch (error) {
        return proxyFailureResponse(error, {
          method: request.method,
          path: requestUrl.pathname,
          routeFamily: "agent-api/thread-follow",
          agentId: registered.agentId,
        });
      }
    }
    if (
      request.method === LOCAL_PROXY_ROUTES.inboxRead.method &&
      requestUrl.pathname === LOCAL_PROXY_ROUTES.inboxRead.path
    ) {
      if (!registered) return new Response("unauthorized", { status: 401 });
      const query = Object.fromEntries(requestUrl.searchParams);
      const target = query.target?.trim() ?? "";
      if (!target) return badRequest();
      const limit = query.limit === undefined ? undefined : Number(query.limit);
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100))
        return badRequest();
      const cursor = query.cursor?.trim() || undefined;
      try {
        const apiKey = authorize(registered);
        if (
          target !== "reminders" &&
          !target.startsWith("reminder:") &&
          input.runtime?.collab &&
          apiKey
        ) {
          return Response.json(
            await input.runtime.collab.readMessagesForInbox(
              registered.context,
              {
                target,
                ...(limit !== undefined ? { limit } : {}),
                ...(cursor !== undefined ? { cursor } : {}),
              },
              apiKey,
            ),
          );
        }
        return await forwardCloudJson(
          registered.agentId,
          "GET",
          agentApiRoutes.cloud.inboxRead.path,
          "Agent inbox read",
          { query: requestUrl.searchParams },
        );
      } catch (error) {
        return proxyFailureResponse(error, {
          method: request.method,
          path: requestUrl.pathname,
          routeFamily: "agent-api/inbox-read",
          agentId: registered.agentId,
        });
      }
    }
    if (
      request.method === LOCAL_PROXY_ROUTES.inboxDismiss.method &&
      requestUrl.pathname === LOCAL_PROXY_ROUTES.inboxDismiss.path
    ) {
      if (!registered) return new Response("unauthorized", { status: 401 });
      if (request.headers.get("content-type")?.toLowerCase() !== "application/json")
        return new Response("unsupported media type", { status: 415 });
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      if (body instanceof Response) return body;
      if (!isRecord(body.payload)) return badRequest();
      try {
        const apiKey = authorize(registered);
        const data = await forwardCloudData(
          registered.agentId,
          "POST",
          agentApiRoutes.cloud.inboxDismiss.path,
          "Agent inbox dismiss",
          { body: body.payload },
        );
        if (data instanceof Response) return data;
        if (apiKey && input.runtime?.collab && isRecord(data) && Array.isArray(data.targets)) {
          await input.runtime.collab.settleDismissedTargets(
            registered.context,
            data.targets.filter((entry): entry is string => typeof entry === "string"),
            apiKey,
            typeof body.payload.target === "string" ? body.payload.target.trim() : undefined,
          );
        }
        return Response.json(data);
      } catch (error) {
        return proxyFailureResponse(error, {
          method: request.method,
          path: requestUrl.pathname,
          routeFamily: "agent-api/inbox-dismiss",
          agentId: registered.agentId,
        });
      }
    }
    if (
      request.method === LOCAL_PROXY_ROUTES.actionWithdraw.method &&
      requestUrl.pathname === LOCAL_PROXY_ROUTES.actionWithdraw.path
    ) {
      if (!registered) return new Response("unauthorized", { status: 401 });
      if (request.headers.get("content-type")?.toLowerCase() !== "application/json")
        return new Response("unsupported media type", { status: 415 });
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      if (body instanceof Response) return body;
      if (!isRecord(body.payload) || typeof body.payload.messageId !== "string")
        return badRequest();
      try {
        authorize(registered);
        return await forwardCloudJson(
          registered.agentId,
          "POST",
          agentApiRoutes.cloud.actionWithdraw.path,
          "Agent action withdraw",
          { body: { messageId: body.payload.messageId } },
        );
      } catch (error) {
        return proxyFailureResponse(error, {
          method: request.method,
          path: requestUrl.pathname,
          routeFamily: "agent-api/action-withdraw",
          agentId: registered.agentId,
        });
      }
    }
    if (
      request.method === LOCAL_PROXY_ROUTES.guidance.method &&
      requestUrl.pathname === LOCAL_PROXY_ROUTES.guidance.path
    ) {
      if (!registered) return new Response("unauthorized", { status: 401 });
      if (request.headers.get("content-type")?.toLowerCase() !== "application/json")
        return new Response("unsupported media type", { status: 415 });
      const body = await readJsonBody(request, MAX_BODY_BYTES);
      if (body instanceof Response) return body;
      if (!isRecord(body.payload)) return badRequest();
      const op = body.payload.operation;
      const cmd = typeof body.payload.command === "string" ? body.payload.command.trim() : "";
      if ((op !== "check" && op !== "satisfy") || !cmd) return badRequest();
      try {
        authorize(registered);
        const collab = input.runtime?.collab;
        const borrowStateDb = collab?.stateDb;
        return Response.json(
          evaluateAgentCommandGuidance({
            stateDirectory: resolveStateDir(),
            hasExplicitStateDir: Boolean(input.stateDirectory || collab),
            ...(borrowStateDb ? { stateDb: () => borrowStateDb(registered.agentId) } : {}),
            agentId: registered.agentId,
            operation: op,
            command: cmd,
            reportsCompaction:
              input.reportsCompaction ??
              (collab ? (id) => collab.reportsCompaction(id) : undefined),
          }),
        );
      } catch (error) {
        return proxyFailureResponse(error, {
          method: request.method,
          path: requestUrl.pathname,
          routeFamily: "agent-api/guidance",
          agentId: registered.agentId,
        });
      }
    }
    return undefined;
  };

  return { dispatchDirect, discardDraft, forwardCloudJson };
}
