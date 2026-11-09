/** How long a deliberate shutdown waits for the server to take its shutdown notice. The whole
 * stop, Agents included, has to fit in the service manager's grace period, which task #726 moved
 * from launchd's 2 s default to `LAUNCHD_EXIT_TIMEOUT_SECONDS` (40 s). The stop's other network
 * waits (reminder work still running) share this bound. It lives in its own module so
 * `daemon-runtime/` reads it without importing the transport, which builds may replace. */
export const DAEMON_SHUTDOWN_NOTICE_TIMEOUT_MS = 1_000;
