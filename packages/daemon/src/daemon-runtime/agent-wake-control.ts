import type { AgentSession } from "@lrm/coforge-anvil";
import type { SessionIdentity } from "@lrm/coforge-sdk/internal";

/** Reads a reused launch's identity without making wake depend on provider availability. */
export function readSessionIdentityOrUndefined(
  session: Pick<AgentSession, "readSessionIdentity">,
): Promise<SessionIdentity | undefined> {
  return Promise.resolve()
    .then(() => session.readSessionIdentity?.())
    .catch(() => undefined);
}

/**
 * The process manager owns the restart identity; control records still belong here.
 * Identity is an enrichment for the reused launch, so a provider read failure keeps the wake.
 */
export function wakeReusedAgent(
  session: Pick<AgentSession, "readSessionIdentity">,
  wake: (identity?: SessionIdentity) => Promise<void>,
): void {
  void readSessionIdentityOrUndefined(session)
    .then(wake)
    .catch(() => {});
}
