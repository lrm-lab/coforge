import {
  decodeReminderDueAckRequest,
  encodeReminderDueAckResponse,
} from "@lrm/coforge-sdk/internal";
import type { ReminderDueWorker } from "#src/server/reminders/reminder-due-worker.server";
import { requireDaemonPrincipal } from "./daemon-rpc-principal.server";
import type { CentrifugoRpcMethod } from "./rpc-handler.server";

export function createReminderDueAckMethod(worker: ReminderDueWorker): CentrifugoRpcMethod {
  return async (payload, metadata) => {
    const request = decodeReminderDueAckRequest(payload);
    const denied = requireDaemonPrincipal(metadata, request);
    if (denied) return denied;
    const accepted = await worker.acknowledge(request, new Date());
    return encodeReminderDueAckResponse({ ...request, accepted });
  };
}
