import type { AgentContextViewRequest, AgentContextViewResult } from "@lrm/coforge-sdk/internal";

export type AgentContextViewViewer = { userId: string; workspaceId: string };
export type AgentContextViewResponse =
  | { status: "ready"; result: AgentContextViewResult }
  | { status: "failed"; result: AgentContextViewResult }
  | { status: "offline" | "unsupported" | "timeout" | "unavailable" };

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
  clear(requestId: string): Promise<void>;
};

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
      }): Promise<boolean>;
      enabled?: (viewer: AgentContextViewViewer) => Promise<boolean>;
      publish(request: AgentContextViewRequest): Promise<void>;
      results: PendingResults;
    },
    private readonly timing: {
      now(): number;
      wait(ms: number): Promise<void>;
      timeoutMs: number;
    } = { now: Date.now, wait: (ms) => Bun.sleep(ms), timeoutMs: 30_000 },
  ) {}

  async view(
    viewer: AgentContextViewViewer,
    input: Omit<AgentContextViewRequest, "protocolMajor" | "requestId" | "workspaceId">,
  ): Promise<AgentContextViewResponse> {
    if (this.dependencies.enabled && !(await this.dependencies.enabled(viewer)))
      return { status: "unsupported" };
    const request: AgentContextViewRequest = {
      protocolMajor: 1,
      requestId: `ctxv_${crypto.randomUUID().replaceAll("-", "")}`,
      workspaceId: viewer.workspaceId,
      ...input,
    };
    if (!(await this.dependencies.owned(viewer, request.computerId)))
      return { status: "unavailable" };
    const scope = { workspaceId: viewer.workspaceId, computerId: request.computerId };
    const [online, supported] = await Promise.all([
      this.dependencies.online(scope),
      this.dependencies.supported({ ...scope, agentId: request.agentId, userId: viewer.userId }),
    ]);
    if (!online) return { status: "offline" };
    if (!supported) return { status: "unsupported" };
    try {
      await this.dependencies.results.begin({ request, userId: viewer.userId });
      await this.dependencies.publish(request);
      const deadline = this.timing.now() + this.timing.timeoutMs;
      while (this.timing.now() < deadline) {
        const result = await this.dependencies.results.read(request.requestId);
        if (result) {
          if (
            !(await this.dependencies.owned(viewer, request.computerId)) ||
            !sameAgentContextViewScope(request, result)
          )
            return { status: "unavailable" };
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
              return { status: "unavailable" };
            }
          }
          return result.status === "failed"
            ? { status: "failed", result }
            : { status: "ready", result };
        }
        await this.timing.wait(100);
      }
      return { status: "timeout" };
    } catch {
      return { status: "unavailable" };
    } finally {
      await this.dependencies.results.clear(request.requestId).catch(() => {});
    }
  }
}
