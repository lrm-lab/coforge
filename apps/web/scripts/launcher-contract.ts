/**
 * What a local Web launcher (supervised-bun.ts) and the server it runs (the preloaded
 * exit-with-launcher.ts) agree on. Constants only: importing this module runs nothing.
 */

/** The file the launcher preloads into its server, in apps/web/scripts. */
export const LAUNCHER_PRELOAD = "exit-with-launcher.ts";
/** The launcher's pid, set for its server child. */
export const LAUNCHER_PID_ENV = "WEB_LAUNCHER_PID";
/** How long the server has to stop after being asked, set for its server child. */
export const LAUNCHER_STOP_GRACE_ENV = "WEB_LAUNCHER_STOP_GRACE_MS";
/** How often the server checks that its launcher is still its parent. */
export const LAUNCHER_POLL_MS = 500;
/**
 * How long a server asked to stop may take before it is killed. Nitro's own shutdown gives open
 * connections 5 s, and a server that has served requests keeps Redis sockets that never close.
 */
export const SERVER_STOP_GRACE_MS = 10_000;
