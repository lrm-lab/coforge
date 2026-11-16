import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "#src/generated/prisma/client";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { PrismaCloudFleet } from "#src/server/db/repositories/host-job.repositories.server";
import { computerCanRunAgent } from "./computer-runtime-availability.server";

type PlacedState = "ready" | "starting" | "offline";

export type CloudAgentComputer = { state: "none" } | { state: PlacedState; computerId: string };

export const CLOUD_AGENT_RUNTIME = {
  provider: RUNTIME_PROVIDER.PI,
  model: "",
  modelProvider: "",
  reasoning: "",
} as const;

const DAEMON_CONNECT_GRACE_MS = 3 * 60_000;

export function cloudAgentComputerState(
  placement: {
    containerReady: boolean;
    workPending: boolean;
    everConnected: boolean;
    lastReportedAt: Date | null;
  },
  daemon: { online: boolean; runsPi: boolean },
  now: Date,
): PlacedState {
  if (placement.workPending) return "starting";
  if (daemon.online) return daemon.runsPi ? "ready" : "starting";
  const justPlaced =
    placement.lastReportedAt !== null &&
    now.getTime() - placement.lastReportedAt.getTime() < DAEMON_CONNECT_GRACE_MS;
  if (!placement.containerReady || !placement.everConnected || justPlaced) return "starting";
  return "offline";
}

export async function readCloudAgentComputer(
  db: PrismaClient,
  principal: { userId: string; workspaceId: string },
): Promise<CloudAgentComputer> {
  const { userId, workspaceId } = principal;
  const placement = await new PrismaCloudFleet(db).defaultPlacement(userId, workspaceId);
  if (!placement) return { state: "none" };
  const { computerId } = placement;
  const online =
    !placement.workPending && (await getComputerStatusCache().get({ workspaceId, computerId }));
  const runsPi =
    online &&
    (await computerCanRunAgent(db, principal, computerId, {
      ...CLOUD_AGENT_RUNTIME,
      hasApiKey: false,
    }));
  return { computerId, state: cloudAgentComputerState(placement, { online, runsPi }, new Date()) };
}
