/** What one launch's session report says about the session it replaces.
 *
 * A driver may name it (a fresh session its own resume turned into), the wake recycle may, and a
 * control-level recovery may. When none of them does, the daemon still knows one fact: the
 * session this launch was asked to resume. A driver that reports a different session id has
 * replaced that one — the native session was gone — so the report must name it, or the server
 * refuses the identity change as an unauthorized swap. Kept provider-independent on purpose:
 * every adapter takes this path, so none of them has to remember the argument.
 */
export type SessionReplacementFacts = Readonly<{
  /** The old session the driver itself reported replacing. */
  driverReplacedSessionId?: string;
  /** The old session a wake recycle deliberately left behind. */
  recycledSessionId?: string;
  /** The old session a control-level recovery already named. */
  requestedReplacedSessionId?: string;
  /** The session this launch was told to continue. */
  requestedSessionId?: string;
  requestedSessionMode?: "create" | "resume";
  reportedSessionId: string;
}>;

/** The session the driver's own report implies was replaced: the one this launch tried to resume,
 * when it reported a different one. Nothing to infer for a create launch or the same id. */
export function inferredReplacedSession(
  facts: Pick<
    SessionReplacementFacts,
    "requestedSessionId" | "requestedSessionMode" | "reportedSessionId"
  >,
): string | undefined {
  if (facts.requestedSessionMode === "create") return undefined;
  const resumed = facts.requestedSessionId;
  return resumed !== undefined && resumed !== facts.reportedSessionId ? resumed : undefined;
}

export function replacedSessionFor(facts: SessionReplacementFacts): string | undefined {
  return (
    facts.driverReplacedSessionId ??
    facts.recycledSessionId ??
    facts.requestedReplacedSessionId ??
    inferredReplacedSession(facts)
  );
}
