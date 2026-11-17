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

const LOCAL_PROXY_ROUTES = agentApiRoutes.proxy;
const THREAD_FOLLOW_SUFFIX = "/follow";
const LOCAL_THREAD_FOLLOW_PREFIX = LOCAL_PROXY_ROUTES.threadFollow
  .path("")
  .slice(0, -THREAD_FOLLOW_SUFFIX.length);

export type AgentProxyCloudForward = {
  serverHttpUrl: string;
  daemonApiKey: () => Promise<string | null>;
};

/**
 * Owns collaboration extensions on the local Agent capability boundary: local held-draft discard,
 * compaction-aware command guidance observations, and direct cloud forwarding for newly approved
 * collaboration routes (`thread follow`, and in P1-7 `inbox read|dismiss` + `action withdraw`).
 */
export function createCollabProxyDispatcher(input: {
  agentApiKeys: { get(agentId: string): string | undefined };
  stateDirectory?: string;
  reportsCompaction?: (agentId: string) => boolean;
  cloudForward?: AgentProxyCloudForward;
}) {
  const stateDirectory =
    input.stateDirectory ?? daemonStartupOptions(process.argv.slice(2)).daemonStateDirectory;

  const resolveCloud = async (agentId: string) => {
    const agentApiKey = input.agentApiKeys.get(agentId);
    if (!agentApiKey) return null;
    if (input.cloudForward) {
      const daemonApiKey = await input.cloudForward.daemonApiKey();
      return daemonApiKey
        ? { agentApiKey, serverHttpUrl: input.cloudForward.serverHttpUrl, daemonApiKey }
        : null;
    }
    const cfg = await new DaemonConfigStore(stateDirectory, {
      serverHttpUrl: Bun.env.COFORGE_DAEMON_SERVER_URL,
    }).load();
    if (!cfg?.serverHttpUrl) return null;
    const daemonApiKey = await new FileDaemonCredentialStore().load(
      cfg.workspaceId,
      cfg.computerId,
    );
    return daemonApiKey ? { agentApiKey, serverHttpUrl: cfg.serverHttpUrl, daemonApiKey } : null;
  };

  const forwardCloudJson = async (
    agentId: string,
    method: "GET" | "POST",
    path: string,
    what: string,
    options: { query?: URLSearchParams; body?: unknown } = {},
  ): Promise<Response> => {
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
    return Response.json(await readAgentResponseJson(res, what));
  };

  const discardDraft = async (
    agentId: string,
    payload: Record<string, unknown>,
  ): Promise<Response> => {
    const target = typeof payload.target === "string" ? payload.target.trim() : "";
    const expected = payload.expectedDraftKey;
    if (
      !target ||
      payload.sendDraft === true ||
      payload.continueAnyway === true ||
      payload.content !== undefined ||
      (expected !== undefined && (typeof expected !== "string" || !expected.trim()))
    )
      return badRequest();
    const idempotencyKey =
      typeof payload.idempotencyKey === "string" && payload.idempotencyKey
        ? payload.idempotencyKey
        : crypto.randomUUID();
    const hasDb =
      Boolean(input.stateDirectory) ||
      existsSync(join(stateDirectory, "agent-state", escapePathIdentity(agentId), "state.db"));
    if (!hasDb) {
      return Response.json({
        idempotencyKey,
        accepted: true,
        clearedDraft: false,
        discarded: false,
        target,
      });
    }
    const stateDb = AgentStateDb.open(stateDirectory, agentId);
    try {
      const store = new AgentMessageDraftStore(stateDb);
      const lookup = await store.lookup(target);
      if (lookup.status !== "found") {
        return Response.json({
          idempotencyKey,
          accepted: true,
          clearedDraft: false,
          discarded: false,
          target,
        });
      }
      if (typeof expected === "string" && lookup.draft.idempotencyKey !== expected) {
        throw new AgentPreflightError(
          "The saved draft no longer matches the expected idempotency key. No request was made and the current draft was left unchanged because it belongs to a different logical send.",
          "SAVED_DRAFT_IDENTITY_CHANGED",
          { draftSaved: false, retryable: false },
        );
      }
      await store.clear(target);
      return Response.json({
        idempotencyKey,
        accepted: true,
        clearedDraft: true,
        discarded: true,
        discardedDraftKey: lookup.draft.idempotencyKey,
        target,
      });
    } finally {
      stateDb.close();
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
      return Response.json(
        evaluateAgentCommandGuidance({
          stateDirectory,
          hasExplicitStateDir: Boolean(input.stateDirectory),
          agentId: registered.agentId,
          operation: op,
          command: cmd,
          reportsCompaction: input.reportsCompaction,
        }),
      );
    }
    return undefined;
  };

  return { dispatchDirect, discardDraft, forwardCloudJson, stateDirectory };
}
