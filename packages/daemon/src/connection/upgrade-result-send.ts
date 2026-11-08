import {
  COMPUTER_UPGRADE_RESULT_METHOD,
  encodeComputerUpgradeResult,
  type ComputerUpgradeResult,
} from "@lrm/coforge-sdk/internal";

/** How many lifecycle request ids a connection remembers as already reported. */
export const REMEMBERED_REQUEST_IDS = 256;

/** Runs one inbound lifecycle request once, keeping failed requests replayable. */
export function acceptLifecycleRequest(
  seen: Set<string>,
  requestId: string,
  run: () => Promise<void>,
): void {
  if (seen.size >= REMEMBERED_REQUEST_IDS) seen.delete(seen.values().next().value!);
  seen.add(requestId);
  try {
    void run().catch(() => {
      seen.delete(requestId);
    });
  } catch (error) {
    seen.delete(requestId);
    throw error;
  }
}

/**
 * Reports one upgrade operation's terminal result. Returns whether this call was the one that
 * put it on the wire; a replay of an already reported operation is dropped, and a failed send
 * stays replayable, matching the dedupe discipline of the other lifecycle results.
 */
export async function sendUpgradeResultOnce(
  rpc: (method: string, payload: Uint8Array) => Promise<unknown>,
  reportedRequestIds: Set<string>,
  result: ComputerUpgradeResult,
): Promise<boolean> {
  if (reportedRequestIds.has(result.requestId)) return false;
  await rpc(COMPUTER_UPGRADE_RESULT_METHOD, encodeComputerUpgradeResult(result));
  if (reportedRequestIds.size >= REMEMBERED_REQUEST_IDS)
    reportedRequestIds.delete(reportedRequestIds.values().next().value!);
  reportedRequestIds.add(result.requestId);
  return true;
}
