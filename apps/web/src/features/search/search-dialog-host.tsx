import { lazy, Suspense, useCallback, useState, type ReactNode } from "react";

import { OpenSearchContext, type SearchIntent } from "./search-dialog-context";
import { SEARCH_FOCUS_EVENT, useSearchShortcut } from "./search-shortcut";

const loadSearchDialog = () =>
  import("./search-dialog").then((module) => ({ default: module.SearchDialog }));

const SearchDialog = lazy(loadSearchDialog);

export function preloadSearchDialog() {
  void loadSearchDialog();
}

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
    else open({ source: "keyboard" });
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
