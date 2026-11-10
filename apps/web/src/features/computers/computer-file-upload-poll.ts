import type { ComputerFileUploadRead } from "#src/server/computers/computer-file-upload.server";
import { pollForAnswer } from "./poll-for-answer";

/** A Computer on a good link places a small file within a moment. */
export const COMPUTER_FILE_UPLOAD_FIRST_POLL_INTERVAL_MS = 250;
/** How often the panel asks once the upload is taking a while. */
export const COMPUTER_FILE_UPLOAD_POLL_INTERVAL_MS = 1_500;
/** Past the server's own limits (300 seconds to store the object and 600 for the Computer to pull
 * it, `COMPUTER_FILE_UPLOAD_TIMING`), so the page shows the server's verdict, not its own. */
export const COMPUTER_FILE_UPLOAD_CLIENT_DEADLINE_MS = 930_000;

/**
 * Asks for a started upload's outcome until it settles (`pollForAnswer`). Not hearing by the
 * deadline, or the panel going away, ends as a timeout; a read that fails on the way is asked
 * again.
 */
export function awaitComputerFileUpload(options: {
  read(): Promise<ComputerFileUploadRead>;
  signal: AbortSignal;
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Exclude<ComputerFileUploadRead, { status: "pending" }>> {
  return pollForAnswer({
    ...options,
    onGiveUp: { status: "failed", reason: "timeout" },
    firstIntervalMs: COMPUTER_FILE_UPLOAD_FIRST_POLL_INTERVAL_MS,
    intervalMs: COMPUTER_FILE_UPLOAD_POLL_INTERVAL_MS,
    deadlineMs: options.deadlineMs ?? COMPUTER_FILE_UPLOAD_CLIENT_DEADLINE_MS,
  });
}
