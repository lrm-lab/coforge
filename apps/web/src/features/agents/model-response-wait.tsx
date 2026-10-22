import { useSyncExternalStore } from "react";
import { m } from "#src/paraglide/messages";

// Only the active wait row subscribes; history never creates ticking timers.
const clock = {
  listeners: new Set<() => void>(),
  timer: undefined as ReturnType<typeof setInterval> | undefined,
  subscribe(listener: () => void) {
    clock.listeners.add(listener);
    clock.timer ??= setInterval(() => {
      for (const notify of clock.listeners) notify();
    }, 1000);
    return () => {
      clock.listeners.delete(listener);
      if (clock.listeners.size > 0) return;
      clearInterval(clock.timer);
      clock.timer = undefined;
    };
  },
  snapshot: () => Math.floor(Temporal.Now.instant().epochMilliseconds / 1000),
  serverSnapshot: () => null,
};

function secondsBetween(start: number, end: number) {
  return Math.max(
    0,
    Math.floor(
      Temporal.Instant.fromEpochMilliseconds(end)
        .since(Temporal.Instant.fromEpochMilliseconds(start))
        .total("seconds"),
    ),
  );
}

export function ModelResponseWait({
  startedAtMs,
  endedAtMs,
  expiresAt,
}: {
  startedAtMs: number;
  endedAtMs?: number;
  /** Present only while the cloud still reports this wait as current. */
  expiresAt?: number;
}) {
  if (endedAtMs !== undefined)
    return (
      <span className="ml-1.5 text-tertiary tabular-nums">
        {m.agent_activity_model_wait_duration({ seconds: secondsBetween(startedAtMs, endedAtMs) })}
      </span>
    );
  if (expiresAt === undefined) return null;
  return <LiveModelResponseWait startedAtMs={startedAtMs} expiresAt={expiresAt} />;
}

function LiveModelResponseWait({
  startedAtMs,
  expiresAt,
}: {
  startedAtMs: number;
  expiresAt: number;
}) {
  const now = useSyncExternalStore(clock.subscribe, clock.snapshot, clock.serverSnapshot);
  if (now === null) return null;
  // A stale display is refreshed by the existing backend status subscription. Stop the
  // elapsed claim at its lease boundary; this clock never decides Agent availability.
  if (now * 1000 >= expiresAt)
    return (
      <span className="ml-1.5 text-tertiary">{m.agent_activity_model_wait_status_pending()}</span>
    );
  return (
    <span className="ml-1.5 text-tertiary tabular-nums">
      {m.agent_activity_model_wait_elapsed({ seconds: secondsBetween(startedAtMs, now * 1000) })}
    </span>
  );
}
