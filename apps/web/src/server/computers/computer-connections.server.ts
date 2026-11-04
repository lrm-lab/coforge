import type { PrismaClient } from "#src/generated/prisma/client";
import type { RuntimeProvider, RuntimeUnavailableCode } from "@lrm/coforge-sdk/internal";
import { PrismaComputerRuntimeRepository } from "#src/server/db/repositories/computer-runtime.repositories.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { listedWorkspaceComputerWhere } from "#src/server/computers/computer-list-visibility.server";
import { ComputerRuntimeVisibility } from "#src/server/computers/computer-runtime-visibility.server";

type OnlineStatus = (scopes: { workspaceId: string; computerId: string }[]) => Promise<boolean[]>;

export type ComputerConnection = {
  id: string;
  name: string;
  displayName: string;
  kind: string;
  cloudSlot: string | null;
  ownedByCurrentUser: boolean;
  online: boolean;
};

export type ComputerConnectionRuntime = {
  provider: RuntimeProvider;
  unavailableCode: RuntimeUnavailableCode | null;
  diagnostic: string | null;
};

type Principal = { workspaceId: string; userId: string };

/**
 * The Computers the member may see in the Workspace (the Computers page's rule), each with its
 * connection state: a narrow read for the screens that only pick or wait for a Computer. The
 * Computers page's own list also reads Agents, upgrades and cloud images, none of which they wait
 * for. `runtimes: true` adds the runtimes the member may use on each. `online` defaults to the
 * Computers page's status cache.
 */
export function listComputerConnections(
  db: PrismaClient,
  principal: Principal,
  options: { online?: OnlineStatus; runtimes: true },
): Promise<(ComputerConnection & { runtimes: ComputerConnectionRuntime[] })[]>;
export function listComputerConnections(
  db: PrismaClient,
  principal: Principal,
  options?: { online?: OnlineStatus; runtimes?: false },
): Promise<ComputerConnection[]>;
export async function listComputerConnections(
  db: PrismaClient,
  { workspaceId, userId }: Principal,
  {
    online = (scopes: Parameters<OnlineStatus>[0]) => getComputerStatusCache().getMany(scopes),
    runtimes = false,
  }: { online?: OnlineStatus; runtimes?: boolean } = {},
) {
  const links = await db.workspaceComputer.findMany({
    where: { workspaceId, computer: listedWorkspaceComputerWhere(userId) },
    select: {
      computer: {
        select: {
          id: true,
          name: true,
          displayName: true,
          kind: true,
          cloudSlot: true,
          ownerId: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  const ids = links.map(({ computer }) => computer.id);
  const [statuses, visible] = await Promise.all([
    online(ids.map((computerId) => ({ workspaceId, computerId }))),
    runtimes
      ? new ComputerRuntimeVisibility(new PrismaComputerRuntimeRepository(db)).list(
          { workspaceId, userId },
          ids,
        )
      : [],
  ]);
  return links.map(({ computer }, index) => ({
    id: computer.id,
    name: computer.name,
    displayName: computer.displayName,
    kind: computer.kind,
    cloudSlot: computer.cloudSlot,
    ownedByCurrentUser: computer.ownerId === userId,
    online: statuses[index] ?? false,
    ...(runtimes
      ? {
          runtimes: visible
            .filter((runtime) => runtime.computerId === computer.id)
            .map((runtime) => ({
              provider: runtime.provider,
              unavailableCode: runtime.unavailableCode,
              diagnostic: runtime.diagnostic,
            })),
        }
      : {}),
  }));
}
