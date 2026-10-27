import { useCallback, useRef, useState } from "react";

/**
 * What a guarded task returns to stay pending after it succeeds: for a submit whose success
 * replaces the page (a navigation), where the controls must stay disabled until it has.
 */
export const STAY_PENDING = Symbol("stay-pending");

type Guard = <Result = void>(
  task: () => Promise<Result | typeof STAY_PENDING>,
) => Promise<Result | undefined>;

/**
 * Serializes an async submit: a second call while one is in flight is dropped, and
 * `pending` mirrors the in-flight state for disabling controls. The task owns its own
 * error handling; the guard only brackets it. It resolves to the task's result, `undefined`
 * when the call was dropped, and a task that returns `STAY_PENDING` leaves the guard pending.
 */
export function useSubmitGuard(): [pending: boolean, guard: Guard] {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const guard: Guard = useCallback(async (task) => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setPending(true);
    let stayPending = false;
    try {
      const result = await task();
      if (result === STAY_PENDING) {
        stayPending = true;
        return undefined;
      }
      return result;
    } finally {
      if (!stayPending) {
        inFlight.current = false;
        setPending(false);
      }
    }
  }, []);
  return [pending, guard];
}
