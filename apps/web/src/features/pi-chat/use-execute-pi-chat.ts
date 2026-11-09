import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { markAiWorkbenchOff } from "#src/features/settings/ai-workbench";
import { isAppErrorCode } from "#src/lib/app-error";
import { executePiChat } from "./pi-chat.functions";

/**
 * `executePiChat` for the Workbench page. The server refuses it once the Workspace's switch is off,
 * and that refusal shows the switch as off, so the page is replaced by the off message instead of
 * staying on a failed call.
 */
export function useExecutePiChat() {
  const execute = useServerFn(executePiChat);
  const queryClient = useQueryClient();
  return useCallback<typeof execute>(
    async (...args) => {
      try {
        return await execute(...args);
      } catch (error) {
        if (isAppErrorCode(error, "ACCESS_DENIED")) markAiWorkbenchOff(queryClient);
        throw error;
      }
    },
    [execute, queryClient],
  );
}
