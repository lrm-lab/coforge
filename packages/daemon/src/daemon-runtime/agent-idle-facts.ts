/** The idle evidence only the runtime holds, as `RuntimeRelease`'s `daemonIdleFacts` port: a
 * working flag, queued deliveries and inputs, a launch or stop in flight, a runner hold, a
 * migration hold and an open tracked @mention — the facts `stalled`/`recover`/`coldIdle` need
 * beyond the process's own. */
export type DaemonIdleFacts = Readonly<{
  working: boolean;
  deliveriesQueued: boolean;
  inputsQueued: boolean;
  launching: boolean;
  stopping: boolean;
  runnerHold: boolean;
  migrating: boolean;
  trackedMentionOpen: boolean;
}>;

export function daemonIdleFacts(
  input: Omit<DaemonIdleFacts, "inputsQueued"> & {
    queue: Readonly<{ items: readonly unknown[]; drain?: unknown }> | undefined;
  },
): DaemonIdleFacts {
  const { queue, ...facts } = input;
  return {
    ...facts,
    inputsQueued: queue !== undefined && (queue.items.length > 0 || queue.drain !== undefined),
  };
}
