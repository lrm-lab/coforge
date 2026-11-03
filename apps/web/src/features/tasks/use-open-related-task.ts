import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import type { ChannelSuggestion } from "#src/features/conversations/reference-completion";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { openTaskAsStep } from "./task-popup-steps";
import type { VisibleTaskName } from "./task-relation-edits";

/**
 * How a Task popup opens a Task it is related to. One of the same conversation is that
 * conversation's popup (`openHere`, which the host owns: a `task` search param, or the Tasks page's
 * own); one in another channel is looked up by the channel's name, as a related Task names it, and
 * opened where the host opens a Task of another conversation (`openIn`: the Tasks page) or, in a
 * conversation, on that channel's page with the popup open. Either way it is a step down from
 * the popup it was opened from (`openTaskAsStep`).
 */
export function useOpenRelatedTask({
  channels,
  openHere,
  openIn,
}: {
  channels: readonly Pick<ChannelSuggestion, "id" | "name">[];
  openHere: (number: number) => void;
  openIn?: (task: { conversationId: string; number: number }) => void;
}) {
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  return useCallback(
    ({ channel: name, number }: VisibleTaskName) => {
      if (name === null) return openTaskAsStep(router.history, () => openHere(number));
      const channel = channels.find((candidate) => candidate.name === name);
      if (!channel) return;
      openTaskAsStep(router.history, () => {
        if (openIn) return openIn({ conversationId: channel.id, number });
        void router.navigate({
          to: "/w/$workspaceSlug/channel/$channelId",
          params: { workspaceSlug, channelId: channel.id },
          search: { task: number },
        });
      });
    },
    [channels, openHere, openIn, router, workspaceSlug],
  );
}
