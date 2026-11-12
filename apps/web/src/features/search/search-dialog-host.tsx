import { lazy, Suspense, useCallback, useState, type ReactNode } from "react";

import { OpenSearchContext, type SearchIntent } from "./search-dialog-context";
import { SEARCH_FOCUS_EVENT, useSearchShortcut } from "./search-shortcut";

const SearchDialog = lazy(() =>
  import("./search-dialog").then((module) => ({ default: module.SearchDialog })),
);

/**
 * Holds the Workspace's search dialog, which Cmd/Ctrl+K, the sidebar's search field and rail icon, the phone Chat list's search field and a channel's "Search
 * this channel" open over whatever page is showing. The open state stays out of the URL: opening
 * search never changes the page's address.
 */
export function SearchDialogHost({
  workspaceId,
  viewerId,
  timeZone,
  children,
}: {
  workspaceId: string;
  viewerId: string;
  timeZone: string | null;
  children: ReactNode;
}) {
  const [intent, setIntent] = useState<SearchIntent>();
  const open = useCallback((next: SearchIntent = {}) => setIntent(next), []);
  useSearchShortcut(() => {
    if (intent) document.dispatchEvent(new Event(SEARCH_FOCUS_EVENT));
    else open();
  });
  return (
    <OpenSearchContext value={open}>
      {children}
      {intent && (
        <Suspense fallback={null}>
          <SearchDialog
            workspaceId={workspaceId}
            viewerId={viewerId}
            timeZone={timeZone}
            intent={intent}
            onClose={() => setIntent(undefined)}
          />
        </Suspense>
      )}
    </OpenSearchContext>
  );
}
