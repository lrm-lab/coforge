import { diagnosticErrorName } from "@lrm/coforge-sdk/internal";
import { noteSessionMemory } from "./session-memory-log";

/**
 * Decides whether this launch opens a fresh session and, when it does, puts the two memory files
 * into its first input; then records the decision once.
 *
 * "Fresh" is the provider's outcome, not only the request's: a start that asked to continue a
 * session the provider no longer has opens a new native session, and that launch must carry the
 * memory even though its request held an id and no `create`.
 */
export async function openLaunchSessionMemory(input: {
  agentId: string;
  launchId: string;
  recycled: boolean;
  sessionMode?: "create" | "resume";
  /** The session the launch asked to continue; absent when it asked for none. */
  requestedSessionId?: string;
  /** The session the provider reported opening; absent when it reported none. */
  reportedSessionId?: string;
  attach: () => Promise<boolean>;
}): Promise<void> {
  const continued =
    input.requestedSessionId === undefined ||
    input.reportedSessionId === undefined ||
    input.reportedSessionId === input.requestedSessionId;
  const freshSession =
    !input.recycled &&
    (input.sessionMode === "create" || input.requestedSessionId === undefined || !continued);
  let injected = false;
  let errorCode: string | undefined;
  if (freshSession) {
    try {
      injected = await input.attach();
    } catch (error) {
      errorCode = diagnosticErrorName(error);
    }
  }
  noteSessionMemory({
    agentId: input.agentId,
    launchId: input.launchId,
    freshSession,
    injected,
    recycled: input.recycled,
    ...(input.sessionMode ? { sessionMode: input.sessionMode } : {}),
    hadSessionId: input.requestedSessionId !== undefined,
    sessionContinued:
      input.requestedSessionId === undefined || input.reportedSessionId === undefined
        ? undefined
        : continued,
    ...(errorCode ? { errorCode } : {}),
  });
}
