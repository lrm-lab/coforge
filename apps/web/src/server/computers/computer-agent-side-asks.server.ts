import {
  AGENT_SIDE_ASK_DEFAULT_TIMEOUT_MS,
  AGENT_SIDE_ASK_KINDS,
  AGENT_SIDE_ASK_MAX_TIMEOUT_MS,
  AGENT_SIDE_ASK_MIN_TIMEOUT_MS,
  AGENT_SIDE_ASK_QUESTION_MAX_CHARS,
  isAgentSideAskRequestId,
  type AgentSideAskAsker,
  type AgentSideAskKind,
  type AgentSideAskRequest,
  type AgentSideAskResult,
} from "@lrm/coforge-sdk/internal";

const KINDS = new Set<string>(AGENT_SIDE_ASK_KINDS);

export type AgentSideAskViewer = { userId: string; workspaceId: string };

export type AgentSideAskStartInput = {
  agentId: string;
  kind: AgentSideAskKind;
  question?: string;
  timeoutMs?: number;
};

export type AgentSideAskStart =
  | { status: "started"; requestId: string; computerId: string }
  | { status: "offline"; reason: "offline" }
  | { status: "unsupported"; reason: "old_daemon" }
  | {
      status: "unavailable";
      reason: "not_found" | "no_computer" | "offline" | "invalid_input";
    };

export type AgentSideAskRead =
  | { status: "pending" }
  | { status: "ready"; result: AgentSideAskResult }
  | { status: "failed"; result: AgentSideAskResult }
  | { status: "unavailable"; reason: "not_found" };

export function sameAgentSideAskScope(
  request: AgentSideAskRequest,
  result: AgentSideAskResult,
): boolean {
  return (
    request.protocolMajor === result.protocolMajor &&
    request.requestId === result.requestId &&
    request.workspaceId === result.workspaceId &&
    request.computerId === result.computerId &&
    request.agentId === result.agentId &&
    request.kind === result.kind &&
    request.asker.userId === result.askerUserId
  );
}

type PendingResults = {
  begin(pending: { request: AgentSideAskRequest; userId: string }): Promise<void>;
  read(requestId: string): Promise<AgentSideAskResult | undefined>;
  clear?(requestId: string): Promise<void>;
};

export type AgentSideAskTarget = {
  computerId: string | null;
  asker: AgentSideAskAsker;
};

function normalizeQuestion(kind: AgentSideAskKind, raw: string | undefined): string | undefined {
  if (kind === "status") return raw && raw.length > 0 ? undefined : "";
  const trimmed = raw?.trim() ?? "";
  if (
    trimmed.length === 0 ||
    trimmed.length > AGENT_SIDE_ASK_QUESTION_MAX_CHARS ||
    trimmed.includes("\0")
  )
    return undefined;
  return trimmed;
}

function normalizeTimeoutMs(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return AGENT_SIDE_ASK_DEFAULT_TIMEOUT_MS;
  return Math.min(
    Math.max(Math.round(raw), AGENT_SIDE_ASK_MIN_TIMEOUT_MS),
    AGENT_SIDE_ASK_MAX_TIMEOUT_MS,
  );
}

export class ComputerAgentSideAsks {
  constructor(
    private readonly dependencies: {
      resolveTarget(
        viewer: AgentSideAskViewer,
        agentId: string,
      ): Promise<AgentSideAskTarget | undefined>;
      visible(viewer: AgentSideAskViewer, agentId: string): Promise<boolean>;
      online(scope: { workspaceId: string; computerId: string }): Promise<boolean>;
      supported(scope: { workspaceId: string; computerId: string }): Promise<boolean>;
      publish(request: AgentSideAskRequest): Promise<void>;
      results: PendingResults;
    },
  ) {}

  async start(
    viewer: AgentSideAskViewer,
    input: AgentSideAskStartInput,
  ): Promise<AgentSideAskStart> {
    if (!KINDS.has(input.kind)) return { status: "unavailable", reason: "invalid_input" };
    const question = normalizeQuestion(input.kind, input.question);
    if (question === undefined) return { status: "unavailable", reason: "invalid_input" };
    const target = await this.dependencies.resolveTarget(viewer, input.agentId);
    if (!target) return { status: "unavailable", reason: "not_found" };
    if (!target.computerId) return { status: "unavailable", reason: "no_computer" };
    const scope = { workspaceId: viewer.workspaceId, computerId: target.computerId };
    const [online, supported] = await Promise.all([
      this.dependencies.online(scope),
      this.dependencies.supported(scope),
    ]);
    if (!online) return { status: "offline", reason: "offline" };
    if (!supported) return { status: "unsupported", reason: "old_daemon" };
    const request: AgentSideAskRequest = {
      protocolMajor: 1,
      requestId: `sask_${crypto.randomUUID().replaceAll("-", "")}`,
      workspaceId: viewer.workspaceId,
      computerId: target.computerId,
      agentId: input.agentId,
      kind: input.kind,
      question,
      timeoutMs: normalizeTimeoutMs(input.timeoutMs),
      asker: target.asker,
    };
    let begun = false;
    try {
      await this.dependencies.results.begin({ request, userId: viewer.userId });
      begun = true;
      await this.dependencies.publish(request);
    } catch {
      if (begun) await this.dependencies.results.clear?.(request.requestId).catch(() => {});
      return { status: "unavailable", reason: "offline" };
    }
    return { status: "started", requestId: request.requestId, computerId: target.computerId };
  }

  async read(
    viewer: AgentSideAskViewer,
    input: { computerId: string; agentId: string; requestId: string },
  ): Promise<AgentSideAskRead> {
    if (!isAgentSideAskRequestId(input.requestId)) return { status: "pending" };
    const result = await this.dependencies.results.read(input.requestId);
    if (
      !result ||
      result.workspaceId !== viewer.workspaceId ||
      result.computerId !== input.computerId ||
      result.agentId !== input.agentId ||
      result.askerUserId !== viewer.userId
    )
      return { status: "pending" };
    if (!(await this.dependencies.visible(viewer, input.agentId)))
      return { status: "unavailable", reason: "not_found" };
    return result.status === "failed" ? { status: "failed", result } : { status: "ready", result };
  }
}
