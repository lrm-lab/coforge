/** One replaceable listener; unsubscribing only clears the listener it registered. */
export class ListenerSlot<Listener extends (value: never) => unknown> {
  #listener: Listener | undefined;

  set(listener: Listener): () => void {
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) this.#listener = undefined;
    };
  }

  get current(): Listener | undefined {
    return this.#listener;
  }

  clear(): void {
    this.#listener = undefined;
  }
}
