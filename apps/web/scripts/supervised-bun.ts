import { join } from "node:path";

import {
  LAUNCHER_PID_ENV,
  LAUNCHER_STOP_GRACE_ENV,
  SERVER_STOP_GRACE_MS,
} from "./launcher-contract";
import { bunExecutable } from "./local-bun";

/** The signals that end a launcher in practice: a stop, Ctrl-C, and a closed terminal. */
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;

/**
 * Runs `bun <args>` as this launcher's child and resolves with its exit code (128 + the signal
 * when a signal ended it). The local Web launchers (start-server, start-web, dev:hmr) wait on the
 * server they start this way, and the server must not outlive them: a stop, Ctrl-C or closed
 * terminal is passed on to it, and a server still running `stopGraceMs` later is killed. The
 * preloaded exit-with-launcher.ts stops it when the launcher is killed outright; `watchLauncher:
 * false` leaves that out.
 */
export async function runSupervisedBun(
  args: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    stopGraceMs?: number;
    watchLauncher?: boolean;
  },
): Promise<number> {
  const stopGraceMs = options.stopGraceMs ?? SERVER_STOP_GRACE_MS;
  const watcher =
    options.watchLauncher === false
      ? []
      : ["--preload", join(import.meta.dir, "exit-with-launcher.ts")];
  const child = Bun.spawn([bunExecutable(), ...watcher, ...args], {
    cwd: options.cwd,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: {
      ...options.env,
      [LAUNCHER_PID_ENV]: String(process.pid),
      [LAUNCHER_STOP_GRACE_ENV]: String(stopGraceMs),
    },
  });
  let kill: ReturnType<typeof setTimeout> | undefined;
  const forward = (signal: NodeJS.Signals) => {
    child.kill(signal);
    kill ??= setTimeout(() => child.kill("SIGKILL"), stopGraceMs);
  };
  for (const signal of FORWARDED_SIGNALS) process.on(signal, forward);
  try {
    return await child.exited;
  } finally {
    clearTimeout(kill);
    for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
  }
}
