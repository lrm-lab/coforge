import { type KeyboardEvent, type RefObject, useCallback, useMemo, useRef } from "react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import { getRouteApi } from "@tanstack/react-router";

import {
  MountedListControls,
  type ListBesideFrom,
} from "#src/features/conversations/conversation-list-button";
import {
  pickConversationPageSearch,
  type HostedConversationTarget,
} from "#src/features/conversations/conversation-page-search";
import { hostedLandingAfterConsume } from "#src/features/conversations/conversation-thread-search";
import { keepsLandingForReview } from "#src/features/conversations/attachment-review-address";
import { HostedConversationPane } from "#src/features/conversations/hosted-conversation-pane";
import { StandaloneThreadContext } from "#src/features/conversations/standalone-thread";
import { ComposerHostContext } from "#src/features/conversations/composer-host";
import { m } from "#src/paraglide/messages";
import { ActivityFlowHint, ActivityFlowHintContext } from "./activity-flow-hint";

const activityRoute = getRouteApi("/w/$workspaceSlug/activity");

/** From `lg` the open conversation sits beside the list; below, it takes the list's place. */
export const ACTIVITY_LIST_BESIDE_FROM: ListBesideFrom = "lg";

/**
 * The list's keyboard while the conversation is open beside it: whether the selected row can be
 * Done (`done`), the ref its composer registers in (`composerRef`), what j, k and E do there
 * (`onListKey`), a character typed there (`onKeyDown`), and the way back to the list.
 */
export type ActivityPaneFlow = {
  done: boolean;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  onListKey: (event: globalThis.KeyboardEvent) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onBackToList: () => void;
};

/**
 * The conversation a row opened, as Chat opens it (`HostedConversationPane`), its back arrow
 * (`ConversationListButton`) calling `onClose`; a thread opened alone (`threadAlone`) shows only
 * the thread, whose close is the pane's and whose "View in channel" opens the conversation at the
 * thread's root (`onOpen`). The page's own address state comes out of the Activity URL, shared
 * structurally: switching the list's view does not re-render the conversation.
 *
 * With `flow` (the list beside it) the caret stays in the list when it opens, its keys float over
 * the composer, and Escape from the composer gives the caret back to the list's selected row.
 */
export function ActivityConversationPane({
  target,
  onOpen,
  onClose,
  flow,
}: {
  target: HostedConversationTarget;
  onOpen: (target: HostedConversationTarget) => void;
  onClose: () => void;
  flow?: ActivityPaneFlow;
}) {
  const { kind, id } = target;
  const onViewInConversation = useCallback(
    (rootId: string) => onOpen({ kind, id, messageId: rootId }),
    [onOpen, kind, id],
  );
  const search = activityRoute.useSearch({
    select: pickConversationPageSearch,
    structuralSharing: true,
  });
  const navigate = activityRoute.useNavigate();
  // A conversation landing is one-shot. Leaving `msg` set makes the pane jump back to it every
  // time Chat/Tasks remounts the stream. A standalone thread keeps `msg`: it is the root.
  const clearLanding = useCallback(() => {
    void navigate({
      replace: true,
      resetScroll: false,
      // A file's review named in the address keeps it, until the review closes.
      search: (previous) => ({
        ...previous,
        msg: keepsLandingForReview(previous) ? previous.msg : undefined,
      }),
    });
  }, [navigate]);
  const onJumpMessageConsumed =
    hostedLandingAfterConsume(Boolean(target.threadAlone)) === "clear" ? clearLanding : undefined;
  // Always provided, so showing the conversation in place of the thread keeps the pane mounted.
  const rootId = target.threadAlone ? target.messageId : undefined;
  const standaloneThread = useMemo(
    () => (rootId ? { rootId, onClose, onViewInConversation } : null),
    [rootId, onClose, onViewInConversation],
  );
  // Stable while the list is beside it: the conversation reads it, and the hint's own state
  // (`ActivityFlowHintContext`, the caret) changes without rendering the conversation again.
  const composerRef = flow?.composerRef;
  const composerHost = useMemo(
    () =>
      composerRef
        ? { autoFocus: false, overhead: <ActivityFlowHint />, composerRef }
        : { autoFocus: true },
    [composerRef],
  );
  const done = flow?.done ?? false;
  const hint = useMemo(() => (composerRef ? { done, composerRef } : null), [done, composerRef]);
  // j, k and E act on the list from anywhere in the conversation but its fields; a popup opened
  // from it is portalled out of this element, so its keys stay its own.
  const pane = useRef<HTMLDivElement>(null);
  const onListKey = (event: globalThis.KeyboardEvent) => flow?.onListKey(event);
  useHotkeys(
    (["J", "K", "E"] as const).map((hotkey) => ({ hotkey, callback: onListKey })),
    { target: pane, enabled: flow !== undefined, ignoreInputs: true },
  );
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!flow) return;
    // Escape that a completion popup took first (`defaultPrevented`), or that an input method
    // spends on its candidates, leaves the caret where it is. Its default is left alone, so what
    // else Escape closes (select mode) still closes.
    if (event.key === "Escape") {
      const composing = event.nativeEvent.isComposing || event.keyCode === 229;
      const own = event.target === flow.composerRef.current;
      if (!event.defaultPrevented && !composing && own) flow.onBackToList();
      return;
    }
    flow.onKeyDown(event);
  };
  return (
    <div ref={pane} className="contents" onKeyDown={onKeyDown}>
      <ActivityFlowHintContext value={hint}>
        <ComposerHostContext value={composerHost}>
          <MountedListControls
            listBesideFrom={ACTIVITY_LIST_BESIDE_FROM}
            backLabel={m.activity_back_to_list()}
            onClose={onClose}
          >
            <StandaloneThreadContext value={standaloneThread}>
              <HostedConversationPane
                target={target}
                search={search}
                label={m.activity_conversation_pane()}
                loadingLabel={m.activity_conversation_loading()}
                failedText={m.activity_conversation_failed()}
                onJumpMessageConsumed={onJumpMessageConsumed}
              />
            </StandaloneThreadContext>
          </MountedListControls>
        </ComposerHostContext>
      </ActivityFlowHintContext>
    </div>
  );
}
