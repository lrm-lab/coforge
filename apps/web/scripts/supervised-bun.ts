import { constants } from "node:os";
import { join } from "node:path";

import {
  LAUNCHER_PID_ENV,
  LAUNCHER_PRELOAD,
  LAUNCHER_STOP_GRACE_ENV,
  SERVER_STOP_GRACE_MS,
} from "./launcher-contract";
import { bunExecutable } from "./local-bun";

/**
 * A stop and Ctrl-C. Not SIGHUP: listening for it would undo `nohup`. A closed terminal ends this
 * launcher by SIGHUP's default action, and the preloaded watcher then stops the server.
 */
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT"] as const;

/**
 * Runs `bun <args>` as this launcher's child and resolves with its exit code (128 + the signal
 * when a signal ended it). The local Web launchers (start-server, start-web, dev:hmr) wait on the
 * server they start this way, and the server must not outlive them: a stop or Ctrl-C is passed
 * on to it, and a server still running `stopGraceMs` later is killed. The
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
    options.watchLauncher === false ? [] : ["--preload", join(import.meta.dir, LAUNCHER_PRELOAD)];
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
    const exitCode = await child.exited;
    // Bun names the signal when it has a name and gives its number otherwise (a real-time signal).
    const signal = child.signalCode;
    if (signal === null) return exitCode;
    return 128 + (typeof signal === "number" ? signal : constants.signals[signal]);
  } finally {
    clearTimeout(kill);
    for (const signal of FORWARDED_SIGNALS) process.off(signal, forward);
  }
}
