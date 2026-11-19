import {
  RUNTIME_MANAGE_ACTIONS,
  RUNTIME_MANAGE_DEFAULT_TIMEOUT_MS,
  RUNTIME_MANAGE_MAX_TIMEOUT_MS,
  RUNTIME_MANAGE_MIN_TIMEOUT_MS,
  isRuntimeManageRequestId,
  type RuntimeManageAction,
  type RuntimeManageRequest,
  type RuntimeManageResult,
} from "@lrm/coforge-sdk/internal";

const ACTIONS = new Set<string>(RUNTIME_MANAGE_ACTIONS);
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type RuntimeManageViewer = { userId: string; workspaceId: string };

export type RuntimeManageStartInput = {
  computerId: string;
  provider: string;
  action: RuntimeManageAction;
  timeoutMs?: number;
};

export type RuntimeManageStart =
  | { status: "started"; requestId: string; computerId: string }
  | { status: "offline"; reason: "offline" }
  | { status: "unsupported"; reason: "old_daemon" }
  | { status: "unavailable"; reason: "not_found" | "offline" | "invalid_input" };

export type RuntimeManageRead =
  | { status: "pending" }
  | { status: "ready"; result: RuntimeManageResult }
  | { status: "failed"; result: RuntimeManageResult }
  | { status: "unavailable"; reason: "not_found" };

export function sameRuntimeManageScope(
  request: RuntimeManageRequest,
  result: RuntimeManageResult,
): boolean {
  return (
    request.protocolMajor === result.protocolMajor &&
    request.requestId === result.requestId &&
    request.workspaceId === result.workspaceId &&
    request.computerId === result.computerId &&
    request.provider === result.provider &&
    request.action === result.action &&
    request.requestedByUserId === result.requestedByUserId
  );
}

type PendingResults = {
  begin(pending: { request: RuntimeManageRequest; userId: string }): Promise<void>;
  read(requestId: string): Promise<RuntimeManageResult | undefined>;
  clear?(requestId: string): Promise<void>;
};

function normalizeTimeoutMs(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return RUNTIME_MANAGE_DEFAULT_TIMEOUT_MS;
  return Math.min(
    Math.max(Math.round(raw), RUNTIME_MANAGE_MIN_TIMEOUT_MS),
    RUNTIME_MANAGE_MAX_TIMEOUT_MS,
  );
}

function isFailedStatus(status: RuntimeManageResult["status"]): boolean {
  return (
    status === "failed" ||
    status === "error" ||
    status === "unsupported" ||
    status === "not_installed"
  );
}

export class ComputerRuntimeManage {
  constructor(
    private readonly dependencies: {
      authorized(viewer: RuntimeManageViewer, computerId: string): Promise<boolean>;
      online(scope: { workspaceId: string; computerId: string }): Promise<boolean>;
      supported(scope: { workspaceId: string; computerId: string }): Promise<boolean>;
      publish(request: RuntimeManageRequest): Promise<void>;
      results: PendingResults;
    },
  ) {}

  async start(
    viewer: RuntimeManageViewer,
    input: RuntimeManageStartInput,
  ): Promise<RuntimeManageStart> {
    if (!ACTIONS.has(input.action) || !PROVIDER_PATTERN.test(input.provider)) {
      return { status: "unavailable", reason: "invalid_input" };
    }
    if (!(await this.dependencies.authorized(viewer, input.computerId))) {
      return { status: "unavailable", reason: "not_found" };
    }
    const scope = { workspaceId: viewer.workspaceId, computerId: input.computerId };
    const [online, supported] = await Promise.all([
      this.dependencies.online(scope),
      this.dependencies.supported(scope),
    ]);
    if (!online) return { status: "offline", reason: "offline" };
    if (!supported) return { status: "unsupported", reason: "old_daemon" };
    const request: RuntimeManageRequest = {
      protocolMajor: 1,
      requestId: `rtm_${crypto.randomUUID().replaceAll("-", "")}`,
      workspaceId: viewer.workspaceId,
      computerId: input.computerId,
      provider: input.provider,
      action: input.action,
      requestedByUserId: viewer.userId,
      timeoutMs: normalizeTimeoutMs(input.timeoutMs),
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
    return { status: "started", requestId: request.requestId, computerId: input.computerId };
  }

  async read(
    viewer: RuntimeManageViewer,
    input: { computerId: string; provider: string; requestId: string },
  ): Promise<RuntimeManageRead> {
    if (!isRuntimeManageRequestId(input.requestId)) return { status: "pending" };
    const result = await this.dependencies.results.read(input.requestId);
    if (
      !result ||
      result.workspaceId !== viewer.workspaceId ||
      result.computerId !== input.computerId ||
      result.provider !== input.provider ||
      result.requestedByUserId !== viewer.userId
    ) {
      return { status: "pending" };
    }
    if (!(await this.dependencies.authorized(viewer, input.computerId))) {
      return { status: "unavailable", reason: "not_found" };
    }
    return isFailedStatus(result.status)
      ? { status: "failed", result }
      : { status: "ready", result };
  }
}
