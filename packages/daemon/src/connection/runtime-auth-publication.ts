import { getLogger } from "@logtape/logtape";
import { decodeRuntimeAuthIntent, type RuntimeAuthIntent } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "connection"]);

/**
 * Answers whether a publication is a runtime-auth intent, delivering an owned one to its
 * controller. An intent for another Computer is ignored; one for this Computer with no
 * controller installed (a reconnect gap) is logged — it used to vanish without a trace,
 * which is how a stuck sign-in stayed invisible.
 */
export function routeRuntimeAuthPublication(
  data: Uint8Array,
  owner: { workspaceId: string; computerId: string },
  deliver: ((intent: RuntimeAuthIntent) => void) | undefined,
): boolean {
  let intent: RuntimeAuthIntent;
  try {
    intent = decodeRuntimeAuthIntent(data);
  } catch {
    return false;
  }
  if (intent.workspaceId !== owner.workspaceId || intent.computerId !== owner.computerId)
    return true;
  if (deliver) {
    deliver(intent);
    return true;
  }
  logger.warning("Runtime auth intent arrived with no controller", {
    event: "runtime_auth:intent_dropped",
    workspace_id: owner.workspaceId,
    computer_id: owner.computerId,
    kind: intent.kind,
    ...("provider" in intent ? { provider: intent.provider } : {}),
    ...("loginId" in intent ? { login_id: intent.loginId } : {}),
    ...("requestId" in intent ? { request_id: intent.requestId } : {}),
  });
  return true;
}
