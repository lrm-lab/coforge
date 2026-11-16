import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";

import { useAppToast } from "#src/components/ui/toast";
import { m } from "#src/paraglide/messages";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { openDirectConversation } from "./conversations.functions";

/**
 * Opens the viewer's direct conversation with an Agent or a member (starting it on first use) and
 * goes to its page. Returns whether it opened; a caller may handle failure inline, otherwise the
 * existing entry points report it in a toast.
 */
export function useOpenDirectConversation(onError?: () => void) {
  const open = useServerFn(openDirectConversation);
  const navigate = useNavigate();
  const workspaceSlug = useWorkspaceSlug();
  const toast = useAppToast();
  return useCallback(
    async (peer: { agentId: string } | { userId: string }, options?: { replace?: boolean }) => {
      try {
        const { conversationId } = await open({ data: peer });
        await navigate({
          to: "/w/$workspaceSlug/dm/$dmId",
          params: { workspaceSlug, dmId: conversationId },
          replace: options?.replace,
        });
        return true;
      } catch {
        if (onError) onError();
        else toast.error(m.conversation_open_error());
        return false;
      }
    },
    [open, navigate, workspaceSlug, toast, onError],
  );
}
