import type { PiChatResult } from "@lrm/coforge-sdk/internal/pi-chat";
import { pollForAnswer } from "#src/features/computers/poll-for-answer";
import { AppError } from "#src/lib/app-error";
import type { PiChatRead } from "#src/server/pi-chat/pi-chat-gateway.server";

/** The reply is usually under a second, so the first read comes soon and each wait doubles. */
export const PI_CHAT_POLL_FIRST_INTERVAL_MS = 50;
export const PI_CHAT_POLL_INTERVAL_MS = 500;
/** As long as the server once held a request, and inside the reply's stored lifetime (30 s). */
export const PI_CHAT_CLIENT_DEADLINE_MS = 25_000;

/**
 * Asks for a started command's reply until it settles (`pollForAnswer`) and ends as the error a
 * refused or failed call was: access denied for a caller who lost the Computer, unavailable for a
 * failed command, an expired request, or no reply by the deadline.
 */
export async function awaitPiChat(options: {
  read(): Promise<PiChatRead>;
  signal: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PiChatResult> {
  const answer = await pollForAnswer({
    ...options,
    onGiveUp: { status: "failed" },
    firstIntervalMs: PI_CHAT_POLL_FIRST_INTERVAL_MS,
    intervalMs: PI_CHAT_POLL_INTERVAL_MS,
    deadlineMs: PI_CHAT_CLIENT_DEADLINE_MS,
  });
  if (answer.status === "ready") return answer.result;
  if (answer.status === "denied") throw new AppError("ACCESS_DENIED");
  throw new AppError("TEMPORARILY_UNAVAILABLE", { errorId: "pi-chat-daemon-unavailable" });
}
