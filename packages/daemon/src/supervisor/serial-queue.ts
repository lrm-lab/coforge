/** Runs operations one at a time, in the order they were asked for; a failure does not stop the
 * ones behind it. */
class SerialQueue {
  #tail = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

export { SerialQueue };
