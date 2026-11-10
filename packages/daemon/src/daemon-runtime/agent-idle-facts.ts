/** The idle evidence only the runtime holds, as `RuntimeRelease`'s `daemonIdleFacts` port: a
 * working flag, queued deliveries and inputs, a launch or stop in flight, a runner hold, a
 * migration hold and an open tracked @mention — the facts `stalled`/`recover`/`coldIdle` need
 * beyond the process's own. */
export type DaemonIdleFacts = Readonly<{
  working: boolean;
  deliveriesQueued: boolean;
  deliveryInFlight: boolean;
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
    /** The Agent's deliveries wait for its provider credential. What that holds (deliveries, kept
     * mentions) does not keep the Agent from a restart that may mend it, a pushed model or login. */
    credentialHeld?: boolean;
  },
): DaemonIdleFacts {
  const { queue, credentialHeld, ...facts } = input;
  return {
    ...facts,
    deliveriesQueued: facts.deliveriesQueued && !credentialHeld,
    trackedMentionOpen: facts.trackedMentionOpen && !credentialHeld,
    inputsQueued: queue !== undefined && (queue.items.length > 0 || queue.drain !== undefined),
  };
}
