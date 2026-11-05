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
  /** The provider explicitly said it replaced the session (a failed resume), when it says so. */
  providerReplaced?: boolean;
  attach: () => Promise<boolean>;
}): Promise<void> {
  const continued =
    input.requestedSessionId === undefined ||
    input.reportedSessionId === undefined ||
    input.reportedSessionId === input.requestedSessionId;
  // A provider that reports its session only after this launch (Claude Code reports at turn end)
  // leaves `reportedSessionId` unknown here: the launch then stays a resume and gets no block. The
  // next fresh session carries the memory instead — better than injecting into a session that may
  // still hold its context.
  const freshSession =
    !input.recycled &&
    (input.sessionMode === "create" ||
      input.requestedSessionId === undefined ||
      input.providerReplaced === true ||
      !continued);
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
      input.providerReplaced === true
        ? false
        : input.requestedSessionId === undefined || input.reportedSessionId === undefined
          ? undefined
          : continued,
    ...(errorCode ? { errorCode } : {}),
  });
}
