export const PROBE_FIRST_SECONDS = 60 * 60;
export const PROBE_CAP_SECONDS = 24 * 60 * 60;
export const PROBE_WINDOW_SECONDS = 30 * 24 * 60 * 60;
export const PROBE_TEXT = "Inbox update: no pending targets";
export const UNAUTHORIZED_GRACE_MS = 24 * 60 * 60 * 1000;

export const probeDelaySeconds = (attempts: number) =>
  Math.min(PROBE_CAP_SECONDS, PROBE_FIRST_SECONDS * 2 ** Math.min(attempts, 10));

export function nextProbe(
  disabledAt: Date,
  attempts: number,
  now: Date,
): { delaySeconds: number; at: Date } | undefined {
  const delaySeconds = probeDelaySeconds(attempts);
  const at = new Date(now.getTime() + delaySeconds * 1000);
  const end = disabledAt.getTime() + PROBE_WINDOW_SECONDS * 1000;
  return at.getTime() > end ? undefined : { delaySeconds, at };
}

export type PushRecovery = {
  resumesOn: "probe_success" | "put";
  nextProbeAt: Date | null;
  probeStoppedAt: Date | null;
};
