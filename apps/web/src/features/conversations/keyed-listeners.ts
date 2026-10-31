/** Who to tell when one key's value changes: the listeners of each key, and none of the others. */
export class KeyedListeners {
  readonly #byKey = new Map<string, Set<() => void>>();

  /** How many keys someone listens to. */
  get size() {
    return this.#byKey.size;
  }

  keys() {
    return this.#byKey.keys();
  }

  /** Listens to one key; the returned function stops. */
  add(key: string, listener: () => void) {
    let listeners = this.#byKey.get(key);
    if (!listeners) this.#byKey.set(key, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.#byKey.get(key) === listeners) this.#byKey.delete(key);
    };
  }

  notify(key: string) {
    for (const listener of this.#byKey.get(key) ?? []) listener();
  }
}
