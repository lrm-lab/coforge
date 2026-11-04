/** The idle evidence only the runtime holds, as `RuntimeRelease`'s `daemonIdleFacts` port: a
 * working flag, queued deliveries and inputs, a launch or stop in flight, a runner hold and a
 * migration hold — the facts `stalled`/`recover`/`coldIdle` need beyond the process's own. */
export function daemonIdleFacts(input: {
  queue: Readonly<{ items: readonly unknown[]; drain?: unknown }> | undefined;
  working: boolean;
  deliveriesQueued: boolean;
  launching: boolean;
  stopping: boolean;
  runnerHold: boolean;
  migrating: boolean;
}): Readonly<{
  working: boolean;
  deliveriesQueued: boolean;
  inputsQueued: boolean;
  launching: boolean;
  stopping: boolean;
  runnerHold: boolean;
  migrating: boolean;
}> {
  const { queue, ...facts } = input;
  return {
    ...facts,
    inputsQueued: queue !== undefined && (queue.items.length > 0 || queue.drain !== undefined),
  };
}
