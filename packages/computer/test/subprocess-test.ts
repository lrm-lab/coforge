import { test } from "bun:test";

/** The budget of a test that starts processes (install.sh and the curl/gzip/shasum it runs, the
 * compiled CLI, a fresh Bun). Unloaded, the slowest such case measured 0.64s (34 cases in 12s), so
 * Bun's 5s default is about 8x. Under a busy machine - several package suites and other Agents'
 * builds at once - process startup stalls for seconds and a whole set of these cases timed out at
 * the same moment. This is that load budget (about 45x the unloaded worst case), not a fix for a
 * slow case: a test that only computes keeps the default. */
export const SUBPROCESS_TEST_TIMEOUT_MS = 30_000;

export const subprocessTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, fn, SUBPROCESS_TEST_TIMEOUT_MS);
