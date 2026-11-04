import type { PrismaClient } from "#src/generated/prisma/client";
import type { ComputerRegisterRequest } from "@lrm/coforge-sdk/internal";
import type { AuthenticatedPrincipal, Workspace } from "#src/server/computers/registration.server";
import type {
  ComputerRegistrationRepository,
  WorkspaceAccess,
} from "#src/server/computers/registration.server";
import { prepareDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import { consumeAttachToken } from "#src/server/computers/computer-attach.server";
import { ComputerRegistrationError } from "#src/server/computers/registration.server";
const audit = (detail: Record<string, unknown>) =>
  console.info(JSON.stringify({ event: "computer_credential", ...detail }));

import { bindUnboundMemoryAgentComputer } from "#src/server/workspace-memory/default-memory-agent.server";
import type { WorkspaceAccess as QueryWorkspaceAccess } from "#src/server/workspaces/query.server";

const workspaceShape = { id: true, slug: true, name: true } as const;
const mapWorkspace = (value: {
  id: string;
  slug: string;
  name: string;
}): Workspace & { readonly name: string } => value;

export class PrismaWorkspaceAccess implements WorkspaceAccess, QueryWorkspaceAccess {
  constructor(private readonly db: PrismaClient) {}
  /** By its current or a former slug; the answer always carries the current one. */
  async findAccessibleBySlug(slug: string, principal: AuthenticatedPrincipal) {
    const member = { members: { some: { userId: principal.userId } } };
    // Nearly every lookup names the current slug: try it alone before the former ones.
    const row =
      (await this.db.workspace.findFirst({ where: { slug, ...member }, select: workspaceShape })) ??
      (await this.db.workspace.findFirst({
        where: { formerSlugs: { some: { slug } }, ...member },
        select: workspaceShape,
      }));
    return row ? mapWorkspace(row) : undefined;
  }
  async getAccessibleBySlug(slug: string, principal: AuthenticatedPrincipal) {
    return this.findAccessibleBySlug(slug, principal);
  }
  /** By id, as the one-shot attach's token names its bound workspace (task #417). */
  async findAccessibleById(id: string, principal: AuthenticatedPrincipal) {
    const row = await this.db.workspace.findFirst({
      where: { id, members: { some: { userId: principal.userId } } },
      select: workspaceShape,
    });
    return row ? mapWorkspace(row) : undefined;
  }
  async getAccessibleById(id: string, principal: AuthenticatedPrincipal) {
    return this.findAccessibleById(id, principal);
  }
  async listAccessible(principal: AuthenticatedPrincipal) {
    const rows = await this.db.workspace.findMany({
      where: { members: { some: { userId: principal.userId } } },
      select: workspaceShape,
      orderBy: { slug: "asc" },
    });
    return rows.map(mapWorkspace);
  }
}

export class PrismaComputerRegistrationRepository implements ComputerRegistrationRepository {
  constructor(private readonly db: PrismaClient) {}
  async register({
    principal,
    workspace,
    request,
  }: {
    principal: AuthenticatedPrincipal;
    workspace: Workspace;
    request: ComputerRegisterRequest;
  }) {
    // The audits name the session consumed and the key issued; both wait for the commit, so a
    // registration that rolls back never leaves a row claiming it happened (task #417).
    const registered = await this.db.$transaction(async (tx) => {
      // A one-shot attach token is consumed here, inside the registration's own transaction:
      // the token and the `sk_computer` it buys change hands atomically — a racing second
      // register finds it gone and a refused register leaves it usable (task #417).
      if (principal.attachSessionId) {
        const consumed = await consumeAttachToken(tx, principal.attachSessionId);
        if (!consumed) throw new ComputerRegistrationError(401, "attach token spent");
      }
      await tx.computer.updateMany({
        where: {
          ownerId: principal.userId,
          machineId: request.machineId,
          name: "",
          displayName: "",
        },
        data: {
          name: request.name.trim(),
          displayName: request.displayName.trim(),
        },
      });
      const computer = await tx.computer.upsert({
        where: {
          ownerId_machineId: {
            ownerId: principal.userId,
            machineId: request.machineId,
          },
        },
        create: {
          ownerId: principal.userId,
          machineId: request.machineId,
          name: request.name.trim(),
          displayName: request.displayName.trim(),
        },
        update: {
          name: request.name.trim(),
        },
      });
      const daemonApiKey = prepareDaemonApiKey({
        principal,
        workspaceId: workspace.id,
        computerId: computer.id,
        kind: "computer",
      });
      await tx.workspaceComputer.upsert({
        where: {
          workspaceId_computerId: { workspaceId: workspace.id, computerId: computer.id },
        },
        create: { workspaceId: workspace.id, computerId: computer.id },
        update: {},
      });
      await tx.daemonApiKey.updateMany({
        where: { computerId: computer.id, workspaceId: workspace.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.daemonApiKey.create({ data: daemonApiKey.record });
      await bindUnboundMemoryAgentComputer(tx, workspace.id);
      return {
        computerId: computer.id,
        workspaceId: workspace.id,
        daemonApiKey: daemonApiKey.apiKey,
      };
    });
    if (principal.attachSessionId)
      audit({
        action: "attach_consumed",
        session_id: principal.attachSessionId,
        workspace_id: workspace.id,
      });
    audit({
      action: "key_issued",
      computer_id: registered.computerId,
      workspace_id: registered.workspaceId,
      via: principal.attachSessionId ? "attach_token" : "login",
    });
    return registered;
  }
}
