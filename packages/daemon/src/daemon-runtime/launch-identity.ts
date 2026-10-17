import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";
import type { ServerLaunchIdentity } from "#src/agent-runtime/agent-process-manager";

/** The session one Agent was last launched under; a later launch may continue it. */
export type SessionReference = {
  requestId: string;
  provider: RuntimeProvider;
  sessionId?: string;
  sessionMode?: "create" | "resume";
  launchId?: string;
  /** The control epoch of the request this reference was last launched/rebound under;
   * read live by `#launchAgent`'s `reportAgentSession` closure (via this
   * same object, mutated in place by `#rebindAgent`, never replaced) so a session report
   * sent after a rebind carries the new epoch instead of the one captured at launch time. */
  controlEpoch?: number;
};

export type LaunchIdentityInput = {
  /** The cloud-supplied identity of this launch; every field falls back to `previous`. */
  request: {
    sessionId?: string;
    requestId?: string;
    previousLaunchId?: string;
    sessionMode?: "create" | "resume";
    control?: { controlEpoch?: number; launchId: string };
  };
  provider: RuntimeProvider;
  previous: SessionReference | undefined;
  /** The server launch identity remembered for a daemon-initiated launch (a wake, no `control`). */
  serverLaunch: ServerLaunchIdentity | undefined;
  newId?: () => string;
};

export type LaunchIdentity = {
  requestId: string;
  reference: SessionReference;
  /** The launch this one hands over from, only when it differs from this launch's own id. */
  previousLaunchId: string | undefined;
  launchId: string;
  /** Whether this launch reuses a remembered server launch identity instead of minting one. */
  reused: boolean;
  /** The scope `authorizeLaunch` checks; an unmanaged/legacy launch sends none. */
  managedScope: { controlEpoch?: number; requestId: string; launchId: string } | undefined;
};

/** Which request, session and launch identity one Agent launch runs under. */
export function resolveLaunchIdentity({
  request,
  provider,
  previous,
  serverLaunch,
  newId = () => crypto.randomUUID(),
}: LaunchIdentityInput): LaunchIdentity {
  const { control } = request;
  const reused = serverLaunch !== undefined;
  const continuing =
    previous?.provider === provider &&
    (!request.requestId || request.requestId === previous.requestId);
  const requestId = request.requestId ?? (continuing ? previous.requestId : newId());
  const reference: SessionReference = {
    requestId,
    provider,
    sessionId: request.sessionId ?? (continuing ? previous.sessionId : undefined),
    sessionMode: request.sessionMode ?? (continuing ? previous.sessionMode : undefined),
    launchId: request.previousLaunchId ?? (continuing ? previous.launchId : undefined),
    controlEpoch: control?.controlEpoch ?? serverLaunch?.controlEpoch,
  };
  // A hand-over is meaningless when the reused launch's identity did not change; omit it so
  // the server never sees a spurious previousLaunchId equal to the report's own launchId.
  const previousLaunchId =
    reference.launchId !== (control?.launchId ?? serverLaunch?.launchId)
      ? reference.launchId
      : undefined;
  const launchId = control?.launchId ?? serverLaunch?.launchId ?? newId();
  // A managed launch's own scope; a reused wake resends the same scope it was remembered
  // under so `authorizeLaunch` can accept it; an unmanaged/legacy launch sends none.
  const managedScope = control
    ? { controlEpoch: control.controlEpoch, requestId, launchId }
    : serverLaunch
      ? {
          controlEpoch: serverLaunch.controlEpoch,
          requestId: serverLaunch.requestId,
          launchId: serverLaunch.launchId,
        }
      : undefined;
  return { requestId, reference, previousLaunchId, launchId, reused, managedScope };
}
