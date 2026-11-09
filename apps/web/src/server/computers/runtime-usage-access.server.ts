import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

import { USAGE_READER_NOT_CONNECTED } from "#src/features/computers/usage-reader-message";
import type {
  UsageCacheKey,
  UsageReadResult,
  UsageResultRecord,
  UsageSnapshot,
} from "#src/server/centrifugo/usage-cache.server";
import { defaultCloudComputerHiddenFromViewer } from "./computer-list-visibility.server";
import type { ComputerRuntimeVisibilityRepository } from "./computer-runtime-visibility.server";
import type { Principal, RuntimeAuthAuthorization } from "./runtime-auth.server";

/**
 * Who may read, and ask the Computer to scan, one runtime's account usage: whoever may sign that
 * runtime in or out (`canManage`: the Computer's owner, or an owner or admin of a Workspace the
 * Computer is connected to), and only for a runtime the Computer has reported on a Computer the
 * viewer may see: another member's default cloud Computer is off the Computer list
 * (`computer-list-visibility.server.ts`) and off this too. A plain member gets nothing, not even
 * the cached reading. The usage cache holds only account labels the Computer masked
 * (`usage-snapshot-decode.server.ts` refuses a label with no `*`).
 *
 * The Computer's owner reads the cached reading whole. Anyone else reads only what the popover
 * draws (`drawnReading`): the owner's account details stay the owner's.
 */
export class RuntimeUsageAccess {
  constructor(
    private readonly dependencies: {
      authorization: RuntimeAuthAuthorization;
      runtimes: Pick<ComputerRuntimeVisibilityRepository, "findInWorkspace">;
      computers: {
        find(
          computerId: string,
        ): Promise<{ kind: string; cloudSlot: string | null; ownerId: string } | null>;
      };
      readCache(target: UsageCacheKey): Promise<UsageReadResult>;
      /** Records the pending scan and asks the Computer; returns the scan id. */
      startScan(target: UsageCacheKey): Promise<string>;
    },
  ) {}

  /** Asks the Computer to scan the runtime; the answer arrives through `read`. */
  async scan(principal: Principal, input: { computerId: string; provider: RuntimeProvider }) {
    const { target } = await this.authorize(principal, input);
    return { scanId: await this.dependencies.startScan(target), status: "pending" as const };
  }

  /** The cached usage result; readable while a scan is still running. */
  async read(principal: Principal, input: { computerId: string; provider: RuntimeProvider }) {
    const { target, runtime } = await this.authorize(principal, input);
    const reading = await this.dependencies.readCache(target);
    return runtime.ownerId === principal.userId ? reading : drawnReading(reading);
  }

  private async authorize(
    principal: Principal,
    input: { computerId: string; provider: RuntimeProvider },
  ) {
    const target = {
      workspaceId: principal.workspaceId,
      computerId: input.computerId,
      provider: input.provider,
    };
    const { authorization, runtimes, computers } = this.dependencies;
    const [allowed, runtime] = await Promise.all([
      authorization.canManage({ userId: principal.userId, ...target }),
      runtimes.findInWorkspace(target.workspaceId, target.computerId, target.provider),
    ]);
    if (!allowed || !runtime) throw new Error("runtime is not available");
    // The owner sees their own Computer; the page polls this every 100ms during a scan.
    if (runtime.ownerId !== principal.userId) {
      const computer = await computers.find(target.computerId);
      if (!computer || defaultCloudComputerHiddenFromViewer(principal.userId, computer))
        throw new Error("runtime is not available");
    }
    return { target, runtime };
  }
}

/**
 * A reading cut to what the popover draws, built from the named fields so a field a newer Computer
 * reports reaches no viewer until the popover draws it. Not drawn for anyone: the Codex credit
 * balance (the popover shows only whether credits exist and whether they are unlimited), the time
 * of the last attempt, the snapshot's own copy of its time, and a failure's message except the one
 * line the popover compares it with. A new object, never the cache's own.
 */
function drawnReading(reading: UsageReadResult): UsageReadResult {
  const result = reading.result;
  if (!result) return reading;
  const { workspaceId, computerId, provider, scanId, status, message, collectedAt, snapshot } =
    result;
  const drawn: UsageResultRecord = {
    workspaceId,
    computerId,
    provider,
    scanId,
    status,
    collectedAt,
    ...(message === USAGE_READER_NOT_CONNECTED && status === "unsupported" ? { message } : {}),
    ...(snapshot ? { snapshot: drawnSnapshot(snapshot) } : {}),
  };
  return { ...reading, result: drawn };
}

function drawnSnapshot(snapshot: UsageSnapshot): UsageSnapshot {
  const { credits } = snapshot;
  return {
    provider: snapshot.provider,
    ...(snapshot.planType !== undefined && { planType: snapshot.planType }),
    ...(snapshot.primary && { primary: snapshot.primary }),
    ...(snapshot.secondary && { secondary: snapshot.secondary }),
    ...(snapshot.officialGroups && { officialGroups: snapshot.officialGroups }),
    ...(snapshot.officialDescription !== undefined && {
      officialDescription: snapshot.officialDescription,
    }),
    ...(credits && { credits: { hasCredits: credits.hasCredits, unlimited: credits.unlimited } }),
    ...(snapshot.creditUsage && { creditUsage: snapshot.creditUsage }),
    ...(snapshot.resetCreditsAvailable !== undefined && {
      resetCreditsAvailable: snapshot.resetCreditsAvailable,
    }),
    ...(snapshot.accountLabel !== undefined && { accountLabel: snapshot.accountLabel }),
    ...(snapshot.health !== undefined && { health: snapshot.health }),
  };
}
