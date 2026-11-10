import { useEffect, useSyncExternalStore } from "react";

/**
 * What the browser tab shows: its title (`label | workspace | CoForge`, as Raft's) and whether its
 * icon carries the unread dot. Both are set from effects, so nothing runs during SSR; the server
 * render keeps the root route's `CoForge` and the plain icon.
 *
 * The title is not a route `head()`: `HeadContent` writes its `<title>` element through React, which
 * touches the DOM only when that element's text changes. The root route's `title: "CoForge"` is the
 * only one in the app and never changes, so a `document.title` set here survives navigation
 * (`@tanstack/react-router` `headContentUtils.tsx` builds the one tag, `Asset.tsx` renders it).
 */

const PRODUCT_NAME = "CoForge";

type Listener = () => void;

const listeners = new Set<Listener>();
function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
function emit() {
  for (const listener of listeners) listener();
}

/**
 * The one place the title is composed. A page without a label shows `workspace | CoForge`, and
 * outside a Workspace only `CoForge`. When the server gives an unread count (task #62), the
 * `(N) ` prefix goes here and `unread` below becomes that count.
 */
export function composeTabTitle({
  label,
  workspaceName,
}: {
  label?: string;
  workspaceName?: string;
}) {
  return [label, workspaceName, PRODUCT_NAME].filter(Boolean).join(" | ");
}

// The pages that have registered a label, in mount order; the latest wins. A stack rather than one
// slot because during a route change the next page can mount before the previous one unmounts, and
// that unmount must not clear the label the next page just set.
let labels: { label: string }[] = [];

function currentLabel() {
  return labels.at(-1)?.label;
}

/**
 * Names the page in the tab title for as long as the calling component is mounted; `undefined`
 * registers nothing. The text is what the page is called (`#general`, `@Ada`, `#general - Thread`),
 * without the Workspace or product name.
 */
export function usePageTitleLabel(label: string | undefined) {
  useEffect(() => {
    if (label === undefined) return;
    const entry = { label };
    labels = [...labels, entry];
    emit();
    return () => {
      labels = labels.filter((it) => it !== entry);
      emit();
    };
  }, [label]);
}

/**
 * Writes the tab title for a page inside a Workspace: the registered label, the Workspace's name
 * and the product. Called once, by the Workspace shell; on leaving the Workspace the title goes back
 * to the product name.
 */
export function useWorkspaceTabTitle(workspaceName: string) {
  const label = useSyncExternalStore(subscribe, currentLabel, () => undefined);
  useEffect(() => {
    document.title = composeTabTitle({ label, workspaceName });
    return () => {
      document.title = composeTabTitle({});
    };
  }, [label, workspaceName]);
}

// Whether the viewer's Activity has unread items. The signal is computed in the Workspace shell
// (the same one as the sidebar dot) while the icon is rendered in the root document, outside it.
let activityUnread = false;

/** Reports whether Activity has unread items, for the tab icon; cleared when the caller unmounts. */
export function useReportActivityUnread(unread: boolean) {
  useEffect(() => {
    activityUnread = unread;
    emit();
    return () => {
      activityUnread = false;
      emit();
    };
  }, [unread]);
}

/** Whether the tab icon shows the unread dot. False in the server render. */
export function useActivityUnreadIcon() {
  return useSyncExternalStore(
    subscribe,
    () => activityUnread,
    () => false,
  );
}
