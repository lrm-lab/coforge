import { isValidReleaseVersion } from "@lrm/coforge-sdk/internal";
import { AppError } from "#src/lib/app-error";
import { createCentrifugoServerApi, daemonOnline } from "#src/server/centrifugo/server-api.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { getCloudImageInventory } from "#src/server/hosts/cloud-image-inventory.server";
import { productionCloudComputers } from "#src/server/hosts/host-production.server";
import { resolveReleaseFeedUrl } from "#src/server/install/install-script.server";
import type { WorkspaceUserContext } from "#src/features/auth/function-auth";
import { upgradeComputerInputSchema } from "#src/features/computers/computer.schemas";
import type { z } from "zod";
import { getComputerUpgradeStore } from "./computer-upgrade-store.server";
import { UpgradeComputer } from "./upgrade-computer.server";
import { isFeatureEnabled } from "#src/server/feature-flags/feature-flags.server";
import { getComputerReleaseState } from "./computer-release-state-composition.server";
import { parseServerReleaseChannel, releaseFeedForChannel } from "./release-channel.server";

type UpgradeComputerInput = z.infer<typeof upgradeComputerInputSchema>;

async function fetchExpectedUpgradeVersion(channel?: string): Promise<string> {
  const parsed = parseServerReleaseChannel(channel);
  if (parsed?.startsWith("pinned:")) return parsed.slice("pinned:".length);
  const feedUrl = parsed ? releaseFeedForChannel(parsed) : resolveReleaseFeedUrl();
  if (!feedUrl) throw new AppError("RELEASE_FEED_UNAVAILABLE");
  const response = await fetch(`${feedUrl}/latest`, { signal: AbortSignal.timeout(3_000) });
  const expectedVersion = response.ok ? (await response.text()).trim() : "";
  if (!isValidReleaseVersion(expectedVersion)) throw new AppError("RELEASE_FEED_UNAVAILABLE");
  return expectedVersion;
}

export async function runUpgradeComputerAction(
  context: Pick<WorkspaceUserContext, "user" | "db" | "workspaceId">,
  data: UpgradeComputerInput,
) {
  const { user, db, workspaceId } = context;
  const computer = await db.computer.findFirst({
    where: { id: data.computerId },
    select: { ownerId: true, kind: true },
  });
  if (!computer || computer.ownerId !== user.id) throw new Error("Computer is not available");
  const scope = { workspaceId, computerId: data.computerId };
  const connection = await db.workspaceComputer.findFirst({
    where: scope,
    select: { id: true },
  });
  if (!connection) throw new Error("Computer is not available");
  const placement = computer.kind === "cloud" ? "cloud" : "local";
  const channelsEnabled = await isFeatureEnabled("computer-release-channels", { workspaceId });
  const releaseChannel =
    placement === "local" && channelsEnabled
      ? await getComputerReleaseState()
          .get(workspaceId, data.computerId)
          .catch(() => undefined)
      : undefined;
  return new UpgradeComputer(
    getComputerUpgradeStore(),
    getComputerStatusCache(),
    () => fetchExpectedUpgradeVersion(releaseChannel),
    createCentrifugoServerApi(),
    daemonOnline(() => createCentrifugoServerApi(), getComputerStatusCache()),
    {
      available: (computerId) => getCloudImageInventory().available(computerId),
      enqueue: async (input) => {
        await productionCloudComputers(db).requestImageUpdate({
          ...input,
          now: new Date(),
        });
      },
      enqueueRuntime: async (input) => {
        await productionCloudComputers(db).requestRuntimeUpdate({
          ...input,
          now: new Date(),
        });
      },
    },
  ).execute({ workspaceId, userId: user.id }, { ...data, placement, releaseChannel });
}
