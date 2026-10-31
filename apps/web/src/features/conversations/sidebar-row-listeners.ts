import { KeyedListeners } from "./keyed-listeners";

/** What a keyed reader needs of a sidebar collection: its changes, each naming the row it moved. */
export type ChangingRows = {
  subscribeChanges(callback: (changes: ReadonlyArray<{ key: string | number }>) => void): {
    unsubscribe(): void;
  };
};

/**
 * Tells each reader of one sidebar row when that row changes, and no one else: a new message moves
 * one row's last message, so it renders that row alone, not the list. The collection is listened to
 * while anyone reads a row of it, once for all of them.
 */
export class RowListeners {
  readonly #rows: ChangingRows;
  readonly #listeners = new KeyedListeners();
  #subscription: { unsubscribe(): void } | undefined;

  constructor(rows: ChangingRows) {
    this.#rows = rows;
  }

  subscribe(key: string, listener: () => void) {
    const stop = this.#listeners.add(key, listener);
    this.#subscription ??= this.#rows.subscribeChanges((changes) => {
      for (const change of changes) this.#listeners.notify(String(change.key));
    });
    return () => {
      stop();
      if (this.#listeners.size > 0) return;
      this.#subscription?.unsubscribe();
      this.#subscription = undefined;
    };
  }
}

const listenersByRows = new WeakMap<ChangingRows, RowListeners>();

/** The one `RowListeners` of a collection, shared by every row read from it. */
export function rowListenersOf(rows: ChangingRows) {
  let listeners = listenersByRows.get(rows);
  if (!listeners) listenersByRows.set(rows, (listeners = new RowListeners(rows)));
  return listeners;
}
