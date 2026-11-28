import { REALTIME_EVENTS } from "#src/features/realtime/realtime-events";
import type { Prisma, PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import { attachmentKeys } from "#src/server/attachments/attachment.server";
import { lockWorkspaceConversations } from "#src/server/conversations/conversation-lock.server";
import { DaemonCredentialRevocations } from "#src/server/db/repositories/daemon-credential-revocation.repositories.server";
import { retryOnWriteConflict } from "#src/server/db/write-conflict.server";
import {
  reconnectDaemon,
  type CentrifugoConnections,
  type CentrifugoServerApi,
} from "#src/server/centrifugo/server-api.server";
import { workspaceConversationChannel } from "#src/features/conversations/conversation-realtime";
import type { WorkspaceDeletedEvent } from "#src/features/workspaces/workspace-realtime";
import type { WorkspaceFileCleanup } from "./file-cleanup.server";
import { assertCanDeleteWorkspace } from "./member-role.server";
import { workspaceMemberRole } from "./workspace-membership.server";
import { errorType } from "#src/server/errors/error-type.server";
import { getWorkspaceComputerInvalidation } from "#src/server/agents/workspace-computer-invalidation.server";
import { revokeComputerTerminalBestEffort } from "#src/server/computers/computer-terminal-production.server";
export type WorkspaceDeletionSignals = {
  workspaceDeleted(workspaceId: string): Promise<void>;
  reconnectDaemons(workspaceId: string, computerIds: readonly string[]): Promise<void>;
};
export type WorkspaceFileRemoval = Pick<WorkspaceFileCleanup, "remove">;
export function centrifugoWorkspaceDeletionSignals(
  centrifugo: () => Pick<CentrifugoServerApi, "publishJson"> & CentrifugoConnections,
): WorkspaceDeletionSignals {
  return {
    async workspaceDeleted(workspaceId) {
      const event: WorkspaceDeletedEvent = { type: REALTIME_EVENTS.workspaceDeleted, workspaceId };
      await centrifugo().publishJson(workspaceConversationChannel(workspaceId), event);
    },
    async reconnectDaemons(workspaceId, computerIds) {
      const api = centrifugo();
      await Promise.all(
        computerIds.map(async (computerId) => {
          await revokeComputerTerminalBestEffort({ workspaceId, computerId, closeShell: true });
          await reconnectDaemon(api, workspaceId, computerId);
        }),
      );
    },
  };
}
const DELETE_TRANSACTION_TIMEOUT_MS = 60000;
const MESSAGE_DELETE_BATCH = 5000;
const DELETE_ATTEMPTS = 3;
export class WorkspaceDeletion {
  constructor(
    private readonly db: PrismaClient,
    private readonly effects: {
      files: WorkspaceFileRemoval;
      signals: WorkspaceDeletionSignals;
    },
  ) {}
  async delete(input: { workspaceId: string; userId: string; confirmSlug: string }) {
    const { workspaceId } = input;
    const workspace = await this.db.workspace.findUnique({
      where: { id: workspaceId },
      select: { slug: true },
    });
    if (!workspace) throw new AppError("NOT_FOUND");
    assertCanDeleteWorkspace(await workspaceMemberRole(this.db, workspaceId, input.userId));
    if (input.confirmSlug !== workspace.slug) throw new AppError("INVALID_INPUT");
    await this.#deleteMessagesInBatches(workspaceId);
    const { computerIds, fileKeys } = await this.#retrying(workspaceId, () =>
      this.db.$transaction((tx) => this.#deleteRowsIn(tx, workspaceId), {
        timeout: DELETE_TRANSACTION_TIMEOUT_MS,
      }),
    );
    console.info(
      JSON.stringify({ event: "workspace_deletion:deleted", workspace_id: workspaceId }),
    );
    void this.effects.files
      .remove(workspaceId, fileKeys)
      .catch((error: unknown) => logEffectFailure("file_removal", workspaceId, error));
    await this.#announce(workspaceId, computerIds);
  }
  async #deleteMessagesInBatches(workspaceId: string) {
    for (;;) {
      const deleted = await this.#retrying(
        workspaceId,
        () => this.db.$executeRaw`
          DELETE FROM "messages" WHERE "id" IN (
            SELECT "id" FROM "messages" WHERE "workspaceId" = ${workspaceId}::uuid
            LIMIT ${MESSAGE_DELETE_BATCH})`,
      );
      if (deleted < MESSAGE_DELETE_BATCH) return;
    }
  }
  #retrying<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
    return retryOnWriteConflict(run, {
      attempts: DELETE_ATTEMPTS,
      onRetry: (attempt) =>
        console.warn(
          JSON.stringify({
            event: "workspace_deletion:retried",
            workspace_id: workspaceId,
            attempt,
          }),
        ),
    });
  }
  async #deleteRowsIn(tx: Prisma.TransactionClient, workspaceId: string) {
    await lockWorkspaceConversations(tx, workspaceId);
    const [locked] = await tx.$queryRaw<
      {
        iconObjectKey: string | null;
      }[]
    >`
      SELECT "iconObjectKey" FROM "workspaces" WHERE "id" = ${workspaceId}::uuid FOR UPDATE`;
    if (!locked) throw new AppError("NOT_FOUND");
    await lockWorkspaceConversations(tx, workspaceId);
    const fileKeys = {
      files: await attachmentKeys(tx, { workspaceId }),
      images: await this.#imageKeys(tx, workspaceId, locked.iconObjectKey),
    };
    const computers = await tx.workspaceComputer.findMany({
      where: { workspaceId },
      select: { computerId: true },
    });
    const revocations = await DaemonCredentialRevocations.recordForWorkspace(tx, workspaceId);
    console.info(
      JSON.stringify({
        event: "workspace_deletion:revocations",
        workspace_id: workspaceId,
        revocations,
      }),
    );
    await tx.message.deleteMany({ where: { workspaceId } });
    await tx.workspace.delete({ where: { id: workspaceId } });
    return { computerIds: computers.map(({ computerId }) => computerId), fileKeys };
  }
  async #announce(workspaceId: string, computerIds: readonly string[]) {
    for (const computerId of computerIds) getWorkspaceComputerInvalidation().notify(computerId);
    await Promise.all([
      this.#signal("workspace_deleted", workspaceId, () =>
        this.effects.signals.workspaceDeleted(workspaceId),
      ),
      computerIds.length
        ? this.#signal("daemon_reconnect", workspaceId, () =>
            this.effects.signals.reconnectDaemons(workspaceId, computerIds),
          )
        : undefined,
    ]);
  }
  async #imageKeys(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    workspaceIconKey: string | null,
  ) {
    const projects = await tx.project.findMany({
      where: { workspaceId, iconObjectKey: { not: null } },
      select: { iconObjectKey: true },
    });
    const apps = await tx.app.findMany({
      where: { ownerWorkspaceId: workspaceId, logoObjectKey: { not: null } },
      select: { logoObjectKey: true },
    });
    return [
      workspaceIconKey,
      ...projects.map(({ iconObjectKey }) => iconObjectKey),
      ...apps.map(({ logoObjectKey }) => logoObjectKey),
    ].filter((key): key is string => key !== null);
  }
  async #signal(signal: string, workspaceId: string, send: () => Promise<void>) {
    try {
      await send();
    } catch (error) {
      logEffectFailure(signal, workspaceId, error);
    }
  }
}

function logEffectFailure(effect: string, workspaceId: string, error: unknown) {
  console.warn(
    JSON.stringify({
      event: "workspace_deletion:effect_failed",
      effect,
      workspace_id: workspaceId,
      error_type: errorType(error),
    }),
  );
}
