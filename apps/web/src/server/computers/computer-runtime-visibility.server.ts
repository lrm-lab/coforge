import type { RuntimeProvider, RuntimeUnavailableCode } from "@lrm/coforge-sdk/internal";

export type ComputerRuntimeRecord = {
  id: string;
  workspaceId: string;
  computerId: string;
  ownerId: string;
  provider: RuntimeProvider;
  version: string;
  displayName: string;
  /** Why the runtime cannot be used; null when it can. */
  unavailableCode: RuntimeUnavailableCode | null;
  /** The runtime's own redacted stderr line, verbatim; only with an `unavailableCode`. */
  diagnostic: string | null;
  observedAt: Date;
  isPublic: boolean;
};

export interface ComputerRuntimeVisibilityRepository {
  /** Every runtime in the Workspace, or only those on `computerIds`. */
  listInWorkspace(workspaceId: string, computerIds?: string[]): Promise<ComputerRuntimeRecord[]>;
  findInWorkspace(
    workspaceId: string,
    computerId: string,
    provider: RuntimeProvider,
  ): Promise<ComputerRuntimeRecord | undefined>;
  findByIdInWorkspace(
    workspaceId: string,
    runtimeId: string,
  ): Promise<ComputerRuntimeRecord | undefined>;
  setPublic(runtimeId: string, isPublic: boolean): Promise<unknown>;
  findFailedAgentIdsForRuntime(
    workspaceId: string,
    computerId: string,
    provider: RuntimeProvider,
    errorCode: string,
  ): Promise<string[]>;
}

type RuntimePrincipal = { userId: string; workspaceId: string };

/** Whether a viewer sees a runtime on the Computer page: its owner always, anyone else only once
 * the owner has made it public. */
export function runtimeVisibleToViewer(
  viewerId: string,
  runtime: { ownerId: string; isPublic: boolean },
): boolean {
  return runtime.ownerId === viewerId || runtime.isPublic;
}

export type RuntimeSelectionCheck =
  | { ok: true }
  | {
      ok: false;
      code: "RUNTIME_NOT_INSTALLED" | "RUNTIME_UNUSABLE" | "RUNTIME_PRIVATE";
      error: string;
    };

export type AgentFailureResetControl = {
  clearLaunchFailure(agentId: string, expectedErrorCode?: string): Promise<boolean>;
};

export class ComputerRuntimeVisibility {
  constructor(
    private readonly runtimes: ComputerRuntimeVisibilityRepository,
    private readonly control?: AgentFailureResetControl,
  ) {}

  /** The runtimes this person may see, on `computerIds` only when given. */
  async list(principal: RuntimePrincipal, computerIds?: string[]) {
    return (await this.runtimes.listInWorkspace(principal.workspaceId, computerIds)).filter(
      (runtime) => runtimeVisibleToViewer(principal.userId, runtime),
    );
  }

  /** Checks why a runtime cannot be selected for an Agent, or returns ok: true when it can. */
  async checkSelection(
    principal: RuntimePrincipal,
    computerId: string,
    provider: RuntimeProvider,
  ): Promise<RuntimeSelectionCheck> {
    const runtime = await this.runtimes.findInWorkspace(
      principal.workspaceId,
      computerId,
      provider,
    );
    if (!runtime) {
      return {
        ok: false,
        code: "RUNTIME_NOT_INSTALLED",
        error: "the configured runtime is not installed on this Computer",
      };
    }
    if (runtime.unavailableCode) {
      return {
        ok: false,
        code: "RUNTIME_UNUSABLE",
        error: `the configured runtime is not usable on this Computer (${runtime.unavailableCode})`,
      };
    }
    if (!runtimeVisibleToViewer(principal.userId, runtime)) {
      return {
        ok: false,
        code: "RUNTIME_PRIVATE",
        error: "the configured runtime is private and not shared with this Agent's owner",
      };
    }
    return { ok: true };
  }

  /** Whether this person may pick the runtime for an Agent. An unusable runtime is never
   * selectable, however it is shared. */
  async canSelect(principal: RuntimePrincipal, computerId: string, provider: RuntimeProvider) {
    const check = await this.checkSelection(principal, computerId, provider);
    return check.ok;
  }

  async setPublic(principal: RuntimePrincipal, runtimeId: string, isPublic: boolean) {
    const runtime = await this.runtimes.findByIdInWorkspace(principal.workspaceId, runtimeId);
    if (!runtime || runtime.ownerId !== principal.userId)
      throw new Error("runtime is not owned by the current user");
    await this.runtimes.setPublic(runtimeId, isPublic);
    if (isPublic && this.control) {
      const agentIds = await this.runtimes.findFailedAgentIdsForRuntime(
        principal.workspaceId,
        runtime.computerId,
        runtime.provider,
        "runtime_private",
      );
      for (const agentId of agentIds) {
        await this.control.clearLaunchFailure(agentId, "runtime_private");
      }
    }
    return { ...runtime, isPublic };
  }
}
