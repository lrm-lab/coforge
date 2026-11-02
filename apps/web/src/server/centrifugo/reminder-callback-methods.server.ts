import { REMINDER_FIRE_METHOD, REMINDER_SNAPSHOT_METHOD } from "@lrm/coforge-sdk/internal";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

/**
 * The reminder callbacks a Computer calls back on, under their current names.
 *
 * The upgrade window that also answered the pre-convention `reminder:v1:*` spellings is closed: the
 * rename to `agent:v1:reminder:*` shipped before 0.1.0, and no supported Computer sends the old
 * names. A Computer that does is unsupported and sees Centrifugo's `104`, not a silent miss.
 */
export function reminderCallbackMethods(
  fire: CentrifugoRpcMethod,
  snapshot: CentrifugoRpcMethod,
): Record<string, CentrifugoRpcMethod> {
  return {
    [REMINDER_FIRE_METHOD]: fire,
    [REMINDER_SNAPSHOT_METHOD]: snapshot,
  };
}
