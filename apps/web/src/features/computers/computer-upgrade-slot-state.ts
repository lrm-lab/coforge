import { availableUpdateVersion } from "./computer-identity";
import type { ComputerUpgradeOutcome, UpgradeRequestErrorCopy } from "./upgrade-failure";

/** An upgrade this panel asked for, with the release it asked for: in flight, held by the server,
 * or refused before the server held it (which leaves no record a reload could find). */
export type ComputerUpgradeRequest =
  | { state: "idle" }
  | { state: "requesting"; version?: string }
  | { state: "accepted"; requestId: string; version?: string }
  | ({ state: "refused"; version?: string } & UpgradeRequestErrorCopy);

/** What the slot under the Version row shows (rules in features/computers/AGENTS.md). `offer` is
 * the newer release, which an available slot installs and a failed one retries; `version` the
 * release an upgrade was to install. */
export type ComputerUpgradeSlotState =
  | { state: "available"; offer: string }
  | { state: "upgrading"; version?: string; delivered: boolean }
  | { state: "failed"; version?: string; failure: UpgradeRequestErrorCopy; offer?: string };

/**
 * The slot's one reading of an upgrade, this panel's own request and the Computer: running and
 * failed upgrades and a newer release for everyone, with Upgrade and Retry only for its owner,
 * nothing otherwise. A stored failure names no release; one this panel requested names the release
 * it asked for.
 */
export function upgradeSlotState({
  upgrade,
  request,
  computer,
  currentVersion,
  latestComputerVersion,
  offer: explicitOffer,
}: {
  upgrade: ComputerUpgradeOutcome | { state: "idle" };
  request: ComputerUpgradeRequest;
  computer: Parameters<typeof availableUpdateVersion>[0];
  /** The version it runs, or the one an upgrade here just reached. */
  currentVersion: string | null | undefined;
  latestComputerVersion: string | null | undefined;
  /** An image replace on offer. `null` means none. Omit to derive a local runtime offer. */
  offer?: string | null;
}): ComputerUpgradeSlotState | null {
  const offer =
    explicitOffer !== undefined
      ? (explicitOffer ?? undefined)
      : availableUpdateVersion(
          { ...computer, computerVersion: currentVersion },
          latestComputerVersion,
        );
  const requested = request.state === "idle" ? undefined : request.version;
  if (upgrade.state === "running")
    return {
      state: "upgrading",
      version: upgrade.version ?? requested,
      delivered: request.state !== "requesting",
    };
  if (upgrade.state === "failed")
    return {
      state: "failed",
      version: upgrade.version ?? requested,
      failure: upgrade.failure,
      offer,
    };
  return offer ? { state: "available", offer } : null;
}
