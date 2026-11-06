/** A daemon's socket answers before its runtime exists to stop, so a stop signal sent while it is
 * still starting used to take the default action: the process ended with 143 instead of exiting
 * cleanly. Capturing the signal first, where startup begins, keeps that from happening; the
 * caller runs its shutdown once it is ready. */
export function captureStopSignal(): Promise<void> {
  const requested = Promise.withResolvers<void>();
  process.once("SIGINT", () => requested.resolve());
  process.once("SIGTERM", () => requested.resolve());
  return requested.promise;
}
