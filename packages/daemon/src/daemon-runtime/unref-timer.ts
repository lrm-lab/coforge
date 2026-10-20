/** Runs `callback` once after `milliseconds`; the returned function cancels it. */
export type UnrefTimerSchedule = (
  callback: () => Promise<void>,
  milliseconds: number,
) => () => void;

/** A one-shot timer that does not keep the process alive. */
export const scheduleUnrefTimer: UnrefTimerSchedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
};
