/** Prefix of the User Timing marks a long-lived process leaves while it starts. The Computer's
 * `main.ts` writes `main` and `daemon_imported` itself, before this module can be imported. */
export const STARTUP_MARK_PREFIX = "coforge:startup:";

/** Records that this process reached `step` of its startup, in ms since the process began. */
export function markStartup(step: string): void {
  performance.mark(`${STARTUP_MARK_PREFIX}${step}`);
}

/**
 * Fields for a process's first log line: when the runtime started (`performance.timeOrigin`,
 * to compare with launchd's or systemd's own spawn time) and how many ms after that each marked
 * step and this call were reached. Most steps run before logging exists, so this is the only
 * record of where a slow start spent its time.
 */
export function startupTiming(): Record<string, string | number> {
  const fields: Record<string, string | number> = {
    process_started_at: new Date(performance.timeOrigin).toISOString(),
  };
  for (const mark of performance.getEntriesByType("mark")) {
    if (!mark.name.startsWith(STARTUP_MARK_PREFIX)) continue;
    fields[`startup_${mark.name.slice(STARTUP_MARK_PREFIX.length)}_ms`] = Math.round(
      mark.startTime,
    );
  }
  fields.startup_ms = Math.round(performance.now());
  return fields;
}
