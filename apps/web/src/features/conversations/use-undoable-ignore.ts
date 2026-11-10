import { useEffect, useMemo, useRef, useState } from "react";

/** How long an ignore can be undone before the card is actually cancelled. */
export const IGNORE_UNDO_MS = 5_000;

type Phase = "idle" | "counting" | "sent";

/**
 * The ignore's timing, apart from React so it can be tested with fake timers. Nothing is sent
 * while it counts. `leave` (the component unmounts, or the page fires `pagehide`) counts as
 * decided: the cancel is sent at once with `keepalive` so it outlives the page, and if that
 * request fails nothing more is done: the card is still pending on the server for next time.
 * `send` is called at most once per ignore.
 */
export function createUndoableIgnore({
  send,
  onChange,
  ms = IGNORE_UNDO_MS,
}: {
  send: (options: { keepalive: boolean }) => Promise<void>;
  /** Called with whether the card is collapsed as ignored. */
  onChange: (ignored: boolean) => void;
  ms?: number;
}) {
  let phase: Phase = "idle";
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    ignore() {
      if (phase !== "idle") return;
      phase = "counting";
      onChange(true);
      timer = setTimeout(() => {
        phase = "sent";
        // A rejected send puts the card back; saying why is the caller's.
        send({ keepalive: false }).catch(() => {
          phase = "idle";
          onChange(false);
        });
      }, ms);
    },
    undo() {
      if (phase !== "counting") return;
      phase = "idle";
      clearTimeout(timer);
      onChange(false);
    },
    leave() {
      if (phase !== "counting") return;
      phase = "sent";
      clearTimeout(timer);
      send({ keepalive: true }).catch(() => undefined);
    },
  };
}

/**
 * An ignore that can be undone for `IGNORE_UNDO_MS`, then cancels (see `createUndoableIgnore`).
 * A rejection from the timed `send` puts the card back (`ignored` is false again).
 */
export function useUndoableIgnore(send: (options: { keepalive: boolean }) => Promise<void>) {
  const [ignored, setIgnored] = useState(false);
  // The latest `send`, so a timer set earlier never sends with a stale closure.
  const sendRef = useRef(send);
  sendRef.current = send;
  const controller = useMemo(
    () =>
      createUndoableIgnore({ send: (options) => sendRef.current(options), onChange: setIgnored }),
    [],
  );
  // The cleanup runs on unmount only (and in dev's mount-unmount-mount, when nothing counts yet).
  useEffect(() => {
    window.addEventListener("pagehide", controller.leave);
    return () => {
      window.removeEventListener("pagehide", controller.leave);
      controller.leave();
    };
  }, [controller]);
  return { ignored, ignore: controller.ignore, undo: controller.undo };
}
