import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { PiChatCommand, PiChatResult } from "@lrm/coforge-sdk/internal/pi-chat";
import { markAiWorkbenchOff } from "#src/features/settings/ai-workbench";
import { isAppErrorCode } from "#src/lib/app-error";
import { awaitPiChat } from "./pi-chat-poll";
import { readPiChat, startPiChat } from "./pi-chat.functions";

/**
 * Runs one Pi chat command for the Workbench page: starts it, then polls for the daemon's reply
 * (`awaitPiChat`), because production closes a request left waiting for about ten seconds. It
 * settles with the reply or throws, and a caller that awaits it starts the next command only
 * after that, so upload chunks keep their order. The server refuses a command once the
 * Workspace's switch is off, and that refusal shows the switch as off, so the page is replaced by
 * the off message instead of staying on a failed call. The wait is bounded by its deadline and not
 * tied to the caller mounting, as the held request it replaces was not.
 */
export function useExecutePiChat() {
  const start = useServerFn(startPiChat);
  const read = useServerFn(readPiChat);
  const queryClient = useQueryClient();
  return useCallback(
    async (args: {
      data: { computerId: string; command: PiChatCommand };
    }): Promise<PiChatResult> => {
      const { computerId } = args.data;
      try {
        const { requestId } = await start(args);
        return await awaitPiChat({
          read: () => read({ data: { computerId, requestId } }),
          signal: new AbortController().signal,
        });
      } catch (error) {
        if (isAppErrorCode(error, "ACCESS_DENIED")) markAiWorkbenchOff(queryClient);
        throw error;
      }
    },
    [start, read, queryClient],
  );
}
