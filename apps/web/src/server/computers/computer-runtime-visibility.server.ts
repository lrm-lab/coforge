import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";
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
      (runtime) => runtime.ownerId === principal.userId || runtime.isPublic,
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
    if (runtime.ownerId !== principal.userId && !runtime.isPublic) {
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

  /** The runtime row itself, only when the current user owns it — so a caller that also needs
   * its fields (e.g. `version`) never runs a second lookup just to get them. */
  async ownedRuntime(principal: RuntimePrincipal, computerId: string, provider: RuntimeProvider) {
    const runtime = await this.runtimes.findInWorkspace(
      principal.workspaceId,
      computerId,
      provider,
    );
    return runtime?.ownerId === principal.userId ? runtime : undefined;
  }

  async isOwner(principal: RuntimePrincipal, computerId: string, provider: RuntimeProvider) {
    return Boolean(await this.ownedRuntime(principal, computerId, provider));
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

/** The one runtime an Agent profile's usage popover gate and CLI-version header share: the
 * Agent's own Computer + runtime, only while both read. One lookup answers both. */
export async function loadAgentOwnedRuntime(
  db: PrismaClient,
  workspaceId: string,
  userId: string,
  agent: { computer?: { id: string } | null },
  runtimeConfig: { runtime: RuntimeProvider } | undefined,
) {
  if (!agent.computer || !runtimeConfig) return undefined;
  return new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db)).ownedRuntime(
    { workspaceId, userId },
    agent.computer.id,
    runtimeConfig.runtime,
  );
}
