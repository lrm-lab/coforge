type Sweep = { start(): void; stop(): void };

export class RuntimeSweeps {
  readonly #sweeps: Sweep[];

  constructor(sweeps: readonly Sweep[]) {
    this.#sweeps = [...sweeps];
  }

  add(sweep: Sweep): void {
    this.#sweeps.push(sweep);
  }

  start(): void {
    for (const sweep of this.#sweeps) sweep.start();
  }

  stop(): void {
    for (const sweep of this.#sweeps) sweep.stop();
  }
}
