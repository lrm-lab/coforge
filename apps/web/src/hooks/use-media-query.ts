import { useCallback, useSyncExternalStore } from "react";

const lists = new Map<string, MediaQueryList>();
const subscribers = new Set<() => void>();

/** Any query's change is news for every query: see `useMediaQuery`. */
function notifyAll() {
  for (const onChange of subscribers) onChange();
}

/** One `MediaQueryList` per query for the page: a message list asks the same two on every row. */
function mediaQueryList(query: string) {
  let list = lists.get(query);
  if (!list) {
    lists.set(query, (list = window.matchMedia(query)));
    list.addEventListener("change", notifyAll);
  }
  return list;
}

function subscribe(onChange: () => void) {
  subscribers.add(onChange);
  return () => {
    subscribers.delete(onChange);
  };
}

/**
 * Whether a media query matches. The server and the render that hydrates the server's markup use
 * `serverValue`, so the markup is the one the server sent; a browser whose query differs then
 * renders again with its own answer. A render that is not hydrating (a client navigation) reads
 * the query directly.
 * https://react.dev/reference/react/useSyncExternalStore#adding-support-for-server-rendering
 *
 * Every subscriber hears the first query that changes, not only its own: a resize that crosses
 * several breakpoints fires one `change` per query, each rendered on its own, and a page that
 * heard them one at a time passed through layouts no viewport has (the task popup's sidebar with a
 * phone's label sheet, whose Back entry then outlived it). Read together, they render as one.
 */
export function useMediaQuery(query: string, serverValue: boolean) {
  const read = useCallback(() => mediaQueryList(query).matches, [query]);
  return useSyncExternalStore(subscribe, read, () => serverValue);
}
