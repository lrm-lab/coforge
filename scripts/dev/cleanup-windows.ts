// The Windows use check of `mise run cleanup` (scripts/dev/cleanup-system.ts): nothing there reports
// another process's directory, but Windows refuses to move a directory a process uses as its
// directory or holds files open in, so the move is the check.
import { rename } from "node:fs/promises";

export type Rename = (from: string, to: string) => Promise<void>;

export type Signal = "SIGINT" | "SIGTERM";

/** Where an interrupt is heard while a worktree is moved aside; tests replace it. */
export type SignalHooks = {
  /** Calls `handler` on SIGINT or SIGTERM until the returned function is called. */
  install: (handler: (signal: Signal) => Promise<void>) => () => void;
  exit: (code: number) => void;
};

const EXIT_CODES: Record<Signal, number> = { SIGINT: 130, SIGTERM: 143 };

export const systemSignalHooks: SignalHooks = {
  install: (handler) => {
    const onInterrupt = (signal: Signal) => void handler(signal);
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    return () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
    };
  },
  exit: (code) => process.exit(code),
};

const BUSY_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

export type Probe = {
  state: "free" | "in use" | "failed" | "stuck";
  detail?: string;
};

/**
 * Renames the worktree aside and straight back. While it is aside, an interrupt moves it back
 * before the process exits, so it is never left under the probe name. `stuck` means it could not be
 * moved back and is elsewhere.
 */
export async function probeInUse(
  path: string,
  options: { move?: Rename; signals?: SignalHooks } = {},
): Promise<Probe> {
  const move = options.move ?? rename;
  const signals = options.signals ?? systemSignalHooks;
  const aside = `${path}.cleanup-probe-${process.pid}`;
  console.error(`checking ${path} for use: moving it to ${aside} and back`);

  const first = move(path, aside);
  let back: Promise<void> | undefined;
  const moveBack = () => (back ??= move(aside, path));
  const removeHandler = signals.install(async (signal) => {
    // Wait for the move aside to settle; if it never happened there is nothing to put back.
    if (
      await first.then(
        () => true,
        () => false,
      )
    ) {
      await moveBack().catch((error: Error) =>
        console.error(`could not move ${aside} back to ${path}: ${error.message}; move it by hand`),
      );
    }
    signals.exit(EXIT_CODES[signal]);
  });
  try {
    try {
      await first;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return BUSY_CODES.has(code ?? "")
        ? { state: "in use" }
        : {
            state: "failed",
            detail: `could not check whether it is in use: ${(error as Error).message}`,
          };
    }
    try {
      await moveBack();
    } catch (error) {
      return {
        state: "stuck",
        detail: `moved ${path} to ${aside} to check whether it is in use and could not move it back (${(error as Error).message}); move it back by hand. Nothing else was touched.`,
      };
    }
    return { state: "free" };
  } finally {
    removeHandler();
  }
}
