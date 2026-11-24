import type { AgentSessionReport, AgentStartIntent } from "@lrm/coforge-sdk/internal";
export type RuntimeSessionReference = {
  provider: string;
  computerId: string;
  sessionId?: string;
  sessionMode?: "create" | "resume";
  state?: "empty" | "resumable" | "unknown";
  startRequestId: string;
  daemonInstanceId: string;
  launchId?: string;
};
export type AgentSessionWriteScope = Pick<
  AgentStartIntent,
  "workspaceId" | "requestId" | "controlEpoch"
> & {
  launchId?: string;
};
export interface AgentSessionRepository {
  read(agentId: string): Promise<
    | {
        workspaceId: string;
        computerId?: string;
        provider: string;
        reference: RuntimeSessionReference | null;
      }
    | undefined
  >;
  replace(
    agentId: string,
    previous: RuntimeSessionReference | null,
    next: RuntimeSessionReference,
    scope: AgentSessionWriteScope,
  ): Promise<boolean>;
}
export type AgentSessionVerifyField =
  | "agent"
  | "workspaceId"
  | "computerId"
  | "provider"
  | "reference"
  | "reference.provider"
  | "reference.computerId"
  | "startRequestId"
  | "daemonInstanceId"
  | "launchId"
  | "sessionId"
  | "currentDaemon";
export type AgentSessionVerifyCategory = "superseded" | "session_mismatch";
export function sessionVerifyCategory(field: AgentSessionVerifyField): AgentSessionVerifyCategory {
  return field === "sessionId" ? "session_mismatch" : "superseded";
}
export class AgentSessionVerifyError extends Error {
  readonly category: AgentSessionVerifyCategory;
  constructor(readonly field: AgentSessionVerifyField) {
    super("Agent session report is stale or unauthorized");
    this.name = "AgentSessionVerifyError";
    this.category = sessionVerifyCategory(field);
  }
}
export type AcceptedSessionMentions = {
  resendForCurrentSession(
    scope: {
      workspaceId: string;
      computerId: string;
      agentId: string;
    },
    options?: {
      includeIssued?: boolean;
    },
  ): Promise<void>;
};
export class AgentSessions {
  constructor(
    private readonly repository: AgentSessionRepository,
    private readonly currentDaemon: (
      workspaceId: string,
      computerId: string,
    ) => Promise<string | undefined>,
    private readonly mentions: AcceptedSessionMentions,
    /** Optional so existing callers and tests keep one dependency: without it the old, stricter
     * single-slot rule applies. */
    private readonly reportedRecently?: (
      workspaceId: string,
      computerId: string,
      workerInstanceId: string,
    ) => Promise<boolean>,
  ) {}
  async prepare(intent: AgentStartIntent): Promise<AgentStartIntent> {
    const agent = await this.repository.read(intent.agentId);
    if (
      !agent ||
      agent.workspaceId !== intent.workspaceId ||
      agent.computerId !== intent.computerId ||
      agent.provider !== intent.provider
    )
      throw new Error("Agent session start scope is not authorized");
    const daemonInstanceId = await this.currentDaemon(intent.workspaceId, intent.computerId);
    if (!daemonInstanceId) throw new Error("Workspace daemon identity is unavailable");
    const old = agent.reference;
    const compatible = old?.provider === intent.provider && old.computerId === intent.computerId;
    const controlled = intent.controlEpoch !== undefined;
    const sameRequest = compatible && old.startRequestId === intent.requestId;
    if (compatible && (!controlled || sameRequest) && old.daemonInstanceId === daemonInstanceId) {
      if (!sameRequest && intent.sessionId && intent.sessionId !== old.sessionId)
        throw new Error("Stop the Agent before selecting a different session");
      if (!(await this.repository.replace(intent.agentId, old, old, intent)))
        throw new Error("Agent session selection changed concurrently");
      return {
        ...intent,
        requestId: old.startRequestId,
        previousLaunchId: old.launchId,
        sessionMode: old.sessionMode ?? (old.sessionId ? "resume" : "create"),
        sessionId: old.sessionId,
      };
    }
    const sessionId =
      intent.sessionId ??
      (compatible && (!controlled || sameRequest) && old.state !== "empty"
        ? old.sessionId
        : undefined) ??
      (intent.provider === "coforge" ? crypto.randomUUID() : undefined);
    const sessionMode =
      (sameRequest && old.sessionId === sessionId ? old.sessionMode : undefined) ??
      intent.sessionMode ??
      (intent.sessionId
        ? "resume"
        : compatible && old.sessionId && old.state !== "empty" && (!controlled || sameRequest)
          ? (old.sessionMode ?? "resume")
          : "create");
    if (sessionMode === "resume" && !sessionId)
      throw new Error("Agent resume requires a session ID");
    const next: RuntimeSessionReference = {
      provider: intent.provider,
      computerId: intent.computerId,
      sessionId,
      sessionMode,
      startRequestId: intent.requestId,
      daemonInstanceId,
      ...(intent.launchId
        ? { launchId: intent.launchId }
        : compatible &&
            old?.startRequestId === intent.requestId &&
            old.daemonInstanceId === daemonInstanceId
          ? { launchId: old.launchId }
          : {}),
    };
    if (!(await this.repository.replace(intent.agentId, old, next, intent)))
      throw new Error("Agent session selection changed concurrently");
    return {
      ...intent,
      previousLaunchId: undefined,
      sessionMode,
      ...(sessionId ? { sessionId } : {}),
    };
  }
  async verify(report: AgentSessionReport): Promise<RuntimeSessionReference> {
    const agent = await this.repository.read(report.agentId);
    const old = agent?.reference;
    const reject = (field: AgentSessionVerifyField): never => {
      throw new AgentSessionVerifyError(field);
    };
    if (!agent) throw new AgentSessionVerifyError("agent");
    if (agent.workspaceId !== report.workspaceId) reject("workspaceId");
    if (agent.computerId !== report.computerId) reject("computerId");
    if (agent.provider !== report.provider) reject("provider");
    if (!old) throw new AgentSessionVerifyError("reference");
    if (old.provider !== report.provider) reject("reference.provider");
    if (old.computerId !== report.computerId) reject("reference.computerId");
    if (old.startRequestId !== report.startRequestId) reject("startRequestId");
    // `old.daemonInstanceId` is whoever held the identity slot when the launch was created, and it is
    // exactly that value the isolated-Computer case corrupts: the slot names one process while
    // another runs the Agent. Accept the process that reported ready for this Computer, so the check
    // still says "a daemon of this Computer" - the launch, session and request ids carry the rest.
    const reported =
      old.daemonInstanceId === report.daemonInstanceId ||
      (await this.reportedRecently?.(
        report.workspaceId,
        report.computerId,
        report.daemonInstanceId,
      )) === true;
    if (!reported) reject("daemonInstanceId");
    if (
      old.launchId &&
      old.launchId !== report.launchId &&
      old.launchId !== report.previousLaunchId
    )
      reject("launchId");
    if (
      old.sessionId &&
      old.sessionId !== report.sessionId &&
      old.sessionId !== report.replacedSessionId
    )
      reject("sessionId");
    if (
      (await this.currentDaemon(report.workspaceId, report.computerId)) !==
        report.daemonInstanceId &&
      !(await this.reportedRecently?.(
        report.workspaceId,
        report.computerId,
        report.daemonInstanceId,
      ))
    )
      reject("currentDaemon");
    return old;
  }
  async accept(report: AgentSessionReport): Promise<void> {
    const old = await this.verify(report);
    const { state: _observedState, ...reference } = old;
    if (
      !(await this.repository.replace(
        report.agentId,
        old,
        {
          ...reference,
          sessionId: report.sessionId,
          sessionMode: "resume",
          launchId: report.launchId,
          ...(report.sessionState ? { state: report.sessionState } : {}),
        },
        { ...report, requestId: report.startRequestId },
      ))
    )
      throw new Error("Agent session identity changed concurrently");
    await this.mentions.resendForCurrentSession({
      workspaceId: report.workspaceId,
      computerId: report.computerId,
      agentId: report.agentId,
    });
  }
  async retire(agentId: string, workspaceId: string, computerId: string): Promise<void> {
    const agent = await this.repository.read(agentId);
    if (!agent || agent.workspaceId !== workspaceId || agent.computerId !== computerId)
      throw new Error("Agent session stop scope is not authorized");
    const old = agent.reference;
    if (!old) return;
    if (
      !(await this.repository.replace(
        agentId,
        old,
        {
          ...old,
          provider: agent.provider,
          computerId,
          sessionId:
            old.provider === agent.provider && old.computerId === computerId
              ? old.sessionId
              : undefined,
          startRequestId: crypto.randomUUID(),
          daemonInstanceId: "",
          launchId: undefined,
        },
        { workspaceId, requestId: old.startRequestId },
      ))
    )
      throw new Error("Agent session identity changed concurrently");
  }
}
