import type { AgentContextViewRequest, AgentContextViewResult } from "@lrm/coforge-sdk/internal";

export type AgentContextViewViewer = { userId: string; workspaceId: string };

/** What starting a view tells the page: the request whose result `read` returns, or a refusal
 * with nothing pending. */
export type AgentContextViewStart =
  | { status: "started"; requestId: string }
  | { status: "offline"; reason: "offline" }
  | { status: "unsupported"; reason?: "unsupported_runtime" | "no_session" | "old_daemon" }
  | { status: "unavailable"; reason: "no_computer" | "offline" };

/** What reading a request tells the page: no result yet, the result, or why it cannot be shown.
 * `read` never returns `timeout`: the page's poll ends as it when no result came in time. */
export type AgentContextViewRead =
  | { status: "pending" }
  | { status: "ready"; result: AgentContextViewResult }
  | { status: "failed"; result: AgentContextViewResult }
  | { status: "unsupported" }
  | { status: "timeout"; reason: "old_daemon" }
  | { status: "unavailable"; reason: "agent_moved" | "read_failed" };

export function sameAgentContextViewScope(
  request: AgentContextViewRequest,
  result: AgentContextViewResult,
): boolean {
  return (
    request.protocolMajor === result.protocolMajor &&
    request.requestId === result.requestId &&
    request.workspaceId === result.workspaceId &&
    request.computerId === result.computerId &&
    request.agentId === result.agentId &&
    request.messageId === result.messageId &&
    request.sessionId === result.sessionId &&
    request.maxBytes === result.maxBytes
  );
}

type PendingResults = {
  begin(pending: { request: AgentContextViewRequest; userId: string }): Promise<void>;
  read(requestId: string): Promise<AgentContextViewResult | undefined>;
};

/**
 * An Agent's context view, restored by its Computer. The Computer can take about 25 seconds and
 * production closes a request idle for about ten, so starting publishes the request and returns at
 * once and the page polls `read`. Both need the feature on and the Computer owned by the viewer;
 * a result is returned only for a request that names the caller's Workspace, Computer and Agent.
 */
export class ComputerAgentContextViews {
  constructor(
    private readonly dependencies: {
      owned(viewer: AgentContextViewViewer, computerId: string): Promise<boolean>;
      online(scope: { workspaceId: string; computerId: string }): Promise<boolean>;
      supported(scope: {
        userId: string;
        workspaceId: string;
        computerId: string;
        agentId: string;
      }): Promise<
        | boolean
        | {
            supported: boolean;
            reason?: "unsupported_runtime" | "no_session" | "old_daemon";
          }
      >;
      enabled?: (viewer: AgentContextViewViewer) => Promise<boolean>;
      visible?: (viewer: AgentContextViewViewer, agentId: string) => Promise<boolean>;
      publish(request: AgentContextViewRequest): Promise<void>;
      results: PendingResults;
    },
  ) {}

  async start(
    viewer: AgentContextViewViewer,
    input: Omit<AgentContextViewRequest, "protocolMajor" | "requestId" | "workspaceId">,
  ): Promise<AgentContextViewStart> {
    if (this.dependencies.enabled && !(await this.dependencies.enabled(viewer)))
      return { status: "unsupported" };
    const request: AgentContextViewRequest = {
      protocolMajor: 1,
      requestId: `ctxv_${crypto.randomUUID().replaceAll("-", "")}`,
      workspaceId: viewer.workspaceId,
      ...input,
    };
    if (!(await this.dependencies.owned(viewer, request.computerId)))
      return { status: "unavailable", reason: "no_computer" };
    const scope = { workspaceId: viewer.workspaceId, computerId: request.computerId };
    const [online, supported] = await Promise.all([
      this.dependencies.online(scope),
      this.dependencies.supported({ ...scope, agentId: request.agentId, userId: viewer.userId }),
    ]);
    if (!online) return { status: "offline", reason: "offline" };
    const support = typeof supported === "boolean" ? { supported } : supported;
    if (!support.supported)
      return { status: "unsupported", ...(support.reason ? { reason: support.reason } : {}) };
    try {
      await this.dependencies.results.begin({ request, userId: viewer.userId });
      await this.dependencies.publish(request);
    } catch {
      // The request expires on its own; the page is told the Computer could not be reached.
      return { status: "unavailable", reason: "offline" };
    }
    return { status: "started", requestId: request.requestId };
  }

  /**
   * The Computer's result for one request. While nothing matching has arrived the answer is
   * pending and nothing else is read; a result is checked against the viewer's access before it
   * is returned, and is left to expire so a poll that lost the reply can ask again. A store that
   * cannot be read throws: the poll asks again.
   */
  async read(
    viewer: AgentContextViewViewer,
    input: { computerId: string; agentId: string; requestId: string },
  ): Promise<AgentContextViewRead> {
    const result = await this.dependencies.results.read(input.requestId);
    if (
      !result ||
      result.workspaceId !== viewer.workspaceId ||
      result.computerId !== input.computerId ||
      result.agentId !== input.agentId
    )
      return { status: "pending" };
    if (this.dependencies.enabled && !(await this.dependencies.enabled(viewer)))
      return { status: "unsupported" };
    if (this.dependencies.visible && !(await this.dependencies.visible(viewer, input.agentId)))
      return { status: "unavailable", reason: "agent_moved" };
    if (!(await this.dependencies.owned(viewer, input.computerId)))
      return { status: "unavailable", reason: "agent_moved" };
    if (result.encoding === "gzip") {
      try {
        return {
          status: "ready",
          result: {
            ...result,
            content: new Uint8Array(Bun.gunzipSync(Buffer.from(result.content))),
            encoding: "identity",
          },
        };
      } catch {
        return { status: "unavailable", reason: "read_failed" };
      }
    }
    return result.status === "failed" ? { status: "failed", result } : { status: "ready", result };
  }
}
