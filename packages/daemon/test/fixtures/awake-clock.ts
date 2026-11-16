import { setSystemTime, spyOn } from "bun:test";

/**
 * The awake clock (`performance.now()`) for a test that fakes time with `setSystemTime`: Bun's
 * `setSystemTime` moves `Date.now()` and leaves `performance.now()` alone, so a stall judged on
 * awake time would never see the fake minutes pass. Here awake time follows the wall clock, except
 * for the time the test puts the machine to `sleep`.
 */
export function installAwakeClock() {
  let sleptMs = 0;
  const spy = spyOn(performance, "now").mockImplementation(() => Date.now() - sleptMs);
  return {
    /** The machine sleeps for `ms`: wall time passes and awake time does not. */
    sleep(ms: number): void {
      setSystemTime(new Date(Date.now() + ms));
      sleptMs += ms;
    },
    restore(): void {
      spy.mockRestore();
    },
  };
}
