import { createMiddleware } from "@tanstack/react-start";

/**
 * How long the browser waits on a read (a GET server function) before abandoning it. A read can
 * hang without ever failing: after the computer sleeps or changes network, the connection under it
 * can be dead while the browser still waits on it, and everything that joins it — a Query refetch,
 * a conversation catching up — waits with it (task #253).
 */
const READ_DEADLINE_MS = 15_000;

/**
 * A signal that aborts when `signal` does, or after `ms` with a `TimeoutError`. Combined by hand:
 * `AbortSignal.any` is missing before Safari 17.4.
 */
export function deadlineSignal(ms: number, signal?: AbortSignal | null): AbortSignal {
  const deadline = AbortSignal.timeout(ms);
  if (!signal) return deadline;
  const combined = new AbortController();
  const follow = (source: AbortSignal) => {
    if (source.aborted) combined.abort(source.reason);
    else source.addEventListener("abort", () => combined.abort(source.reason), { once: true });
  };
  follow(signal);
  follow(deadline);
  return combined.signal;
}

/**
 * Gives every read made from the browser a deadline of `ms`, on top of the caller's own signal (a
 * Query's cancel). Writes (POST) get none: one abandoned in the browser may still have been made.
 * Registered for every server function in `start.ts`; a read that is slow by nature adds its own,
 * longer one, which replaces it.
 */
export const readDeadline = (ms = READ_DEADLINE_MS) =>
  createMiddleware({ type: "function" }).client(({ method, next }) =>
    method === "GET"
      ? next({
          fetch: (input, init) =>
            fetch(input, { ...init, signal: deadlineSignal(ms, init?.signal) }),
        })
      : next(),
  );
