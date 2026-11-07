/** `agent_control:operation_superseded` is normal behaviour, logged at info. Other
 * `agent_control:*` telemetry (request/command/result timings) is unrelated noise, so
 * only the superseded event is collected. */
export function captureInfo() {
  const events: unknown[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    const event = JSON.parse(args[0] as string) as { event?: string } | null;
    if (event?.event === "agent_control:operation_superseded") events.push(event);
  };
  return {
    events,
    restore: () => {
      console.info = original;
    },
  };
}
