import type { QueryClient } from "@tanstack/react-query";
import { createIsomorphicFn } from "@tanstack/react-start";

import type { FinishedWindow } from "#src/features/tasks/finished-tasks";
import { finishedSummaryQuery } from "#src/features/tasks/use-finished-tasks";
import type { ConversationTab } from "./conversation-tabs";
import {
  channelNamesQuery,
  directConversationQuery,
  ensureConversationWindow,
  publicChannelQuery,
  savedMessagesQuery,
} from "./conversation-queries";
import { NO_SAVED } from "./saved-messages-collection";

/** Which conversation a page shows, by its id: a channel or a direct conversation. */
export type ConversationPageTarget = { kind: "channel" | "dm"; id: string };

/**
 * What a conversation page's loader depends on, from its host's address: the message it lands on
 * (an open thread's root, else the jump target) and, on the Tasks tab, the finished-work window
 * whose counts it reads.
 */
export function conversationPageLoaderDeps(search: {
  message?: string;
  threadRootId?: string;
  view?: ConversationTab;
  completed?: Exclude<FinishedWindow, "week">;
}) {
  return {
    anchor: search.threadRootId ?? search.message,
    tasks: search.view === "tasks" ? (search.completed ?? "week") : undefined,
  } as const;
}

/**
 * Reads what a conversation page shows first, as every host opens it: the window around the anchor,
 * then the Tasks tab's finished-work counts. It reads in the browser only: a conversation's messages
 * are never read while the server renders a page, so none of them is in the document the server
 * sends. The page itself is rendered in the browser too (Chat's routes are `ssr: false`; the hosted
 * pane is under `ClientOnly`) and reads the same Query on its own when a host's loader has not.
 * https://tanstack.com/start/latest/docs/framework/react/guide/execution-model
 */
export const loadConversationPage = createIsomorphicFn()
  .server(async (..._read: Parameters<typeof readConversationPage>): Promise<void> => {})
  .client(readConversationPage);

/**
 * Reads what a hosted pane (`HostedConversationPane`) shows first: the conversation page, as
 * `loadConversationPage` reads it, with what Chat's layout would have read for it, the Workspace's
 * channel names and the viewer's Saved list. In the browser only, as `loadConversationPage`.
 */
export const loadHostedConversation = createIsomorphicFn()
  .server(async (..._read: Parameters<typeof readHostedConversation>): Promise<void> => {})
  .client(readHostedConversation);

async function readHostedConversation(
  ...[queryClient, target, deps, options]: Parameters<typeof readConversationPage>
): Promise<void> {
  const workspaceId = options.workspaceId();
  // A failed Saved read starts from an empty list, as in Chat: stale at once, so the next read
  // replaces the stand-in.
  const saved = workspaceId.then((workspaceId) => {
    const query = savedMessagesQuery(workspaceId);
    return queryClient.ensureQueryData(query).catch(() => {
      if (queryClient.getQueryData(query.queryKey) !== undefined) return;
      queryClient.setQueryData(query.queryKey, NO_SAVED);
      return queryClient.invalidateQueries({ queryKey: query.queryKey, refetchType: "none" });
    });
  });
  await Promise.all([
    readConversationPage(queryClient, target, deps, { ...options, workspaceId: () => workspaceId }),
    workspaceId.then((workspaceId) => queryClient.ensureQueryData(channelNamesQuery(workspaceId))),
    saved,
  ]);
}

async function readConversationPage(
  queryClient: QueryClient,
  target: ConversationPageTarget,
  deps: ReturnType<typeof conversationPageLoaderDeps>,
  {
    cause,
    workspaceId,
  }: { cause: "preload" | "enter" | "stay"; workspaceId: () => Promise<string> },
): Promise<void> {
  const window =
    target.kind === "channel"
      ? await ensureConversationWindow(
          queryClient,
          publicChannelQuery(target.id).query,
          deps.anchor,
        )
      : await ensureConversationWindow(
          queryClient,
          directConversationQuery(target.id).query,
          deps.anchor,
        );
  const conversationId = window.pages.at(-1)?.conversationId;
  if (!deps.tasks || !conversationId) return;
  const completedWindow = deps.tasks;
  const summary = workspaceId().then((workspaceId) =>
    queryClient.ensureQueryData(
      finishedSummaryQuery({ workspaceId, conversationId }, completedWindow),
    ),
  );
  // Arriving from another kind of page (`enter`: a first load, or from a channel to a direct
  // message and back) waits for the counts. Staying on this kind of page (`stay`: switching to
  // the Tasks tab, changing the window, or opening another conversation of the same kind) only
  // starts the read: the board shows its loading state until the counts arrive
  // (`finished.pending`), so the page never gives way to its loading page for them.
  if (cause === "stay") void summary.catch(() => undefined);
  else await summary;
}
