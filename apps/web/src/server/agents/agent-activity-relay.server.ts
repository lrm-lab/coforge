import { agentActivityChannelFor } from "#src/features/agents/agent-activity";
import { AGENT_VISIBILITY } from "#src/features/agents/agent-visibility";

/** What the Agent Activity channel's publish proxy asks of the database and of Centrifugo. */
export type ActivityRelayDependencies = {
  agentBelongsToWorkspace(workspaceId: string, agentId: string): Promise<boolean>;
  agentBelongsToComputer(
    workspaceId: string,
    agentId: string,
    computerId: string,
  ): Promise<boolean>;
  computerBelongsToWorkspace(workspaceId: string, computerId: string): Promise<boolean>;
  /** The Agent's current visibility, read fresh (no cache) for every publication —
   * never assumed from a prior request, and never optional: a caller that cannot answer this
   * question must not silently fall back to the shared channel. A recognized non-`"public"`
   * value routes the frame to the per-Agent channels; an unrecognized persisted value fails
   * closed the same way `canSeeAgent`/`visibleAgentWhere` treat it. `undefined` — the lookup
   * found nothing to route by — is rejected outright; `agentBelongsToWorkspace` already rejects
   * an Agent that is not in the workspace, so this is the only other path to it. */
  agentVisibility(workspaceId: string, agentId: string): Promise<string | undefined>;
  /** Raw binary publish (Centrifugo server API `publish`, not the JSON `publishJson`): re-routes
   * a private Agent's frame to its own per-Agent activity channel — the public path still lets
   * Centrifugo do the actual shared-channel publish via the returned `result.b64data` — and puts
   * a reply intent on its conversation or peer user channel. `skipHistory` keeps a transient frame out of the
   * channel's history. */
  publish?(channel: string, data: Uint8Array, options?: { skipHistory?: boolean }): Promise<void>;
};

const bytesToBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** Centrifugo's publish proxy treats an `error` result as a plain denial that leaves the
 * connection open (https://centrifugal.dev/docs/server/proxy#publish-proxy). */
const refusal = (code: number, message: string) => Response.json({ error: { code, message } });

export const publicationDenied = () => refusal(403, "activity publication is not authorized");

/** The least noisy refusal Centrifugo has for a frame that was delivered some other way: unlike
 * a `disconnect` result, it does not drop the Daemon's entire WSS connection over one Agent. */
export const publicationRerouted = (where: string) =>
  refusal(1000, `activity re-routed to ${where}`);

/** Whether the Agent belongs to the Workspace and to the Computer whose connection published. */
export async function agentInPublicationScope(
  dependencies: Pick<
    ActivityRelayDependencies,
    "agentBelongsToWorkspace" | "agentBelongsToComputer" | "computerBelongsToWorkspace"
  >,
  scope: { workspaceId: string; computerId: string; agentId: string },
): Promise<boolean> {
  const { workspaceId, computerId, agentId } = scope;
  return (
    (await dependencies.computerBelongsToWorkspace(workspaceId, computerId)) &&
    (await dependencies.agentBelongsToWorkspace(workspaceId, agentId)) &&
    (await dependencies.agentBelongsToComputer(workspaceId, agentId, computerId))
  );
}

/**
 * Delivers one validated Activity-channel frame to the Agent's audience: the shared channel for a
 * public Agent (by answering the publish proxy with the frame), its own per-Agent channel for any
 * other. A failed re-publish is best-effort, like every other Activity delivery: it only means
 * this one frame is missed live.
 */
export async function relayActivityFrame(
  frame: Uint8Array,
  agent: { workspaceId: string; agentId: string; visibility: string },
  dependencies: Pick<ActivityRelayDependencies, "publish">,
): Promise<Response> {
  if (agent.visibility === AGENT_VISIBILITY.PUBLIC)
    return Response.json({ result: { skip_history: true, b64data: bytesToBase64(frame) } });
  await dependencies
    .publish?.(agentActivityChannelFor(agent.workspaceId, agent.agentId, agent.visibility), frame)
    .catch(() => {});
  return publicationRerouted("a private channel");
}
