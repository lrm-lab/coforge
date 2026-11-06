import {
  decodeAgentReminderOperationResponse,
  decodeLocalReminderRequest,
  encodeAgentReminderOperationResponse,
  encodeLocalReminderRequest,
  type AgentReminderOperationResponse,
  type LocalReminderRequest,
} from "@lrm/coforge-sdk/internal";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import type { ReminderResponse, ReminderTransportRequest } from "./reminder-commands";

/** Posts one validated reminder command to the daemon-local proxy route and decodes its answer. */
export async function reminderRequest(
  proxyEndpoint: (path: string) => URL,
  context: string,
  proxyUrl: string,
  fields: ReminderTransportRequest,
): Promise<ReminderResponse> {
  if (!context || !/^sfp_[A-Za-z0-9_-]{43}$/.test(context))
    throw new Error("coforge agent context is invalid");
  if (!proxyUrl) throw new Error("coforge agent proxy is not configured");
  const idempotencyKey = crypto.randomUUID();
  const validated = decodeLocalReminderRequest(
    encodeLocalReminderRequest({ ...fields, idempotencyKey, context } as LocalReminderRequest),
  );
  const { context: _implicitContext, ...body } = validated;
  let response: Response;
  try {
    response = await fetch(proxyEndpoint(agentApiRoutes.proxy.reminders.path), {
      method: agentApiRoutes.local.reminders.method,
      headers: { authorization: `Bearer ${context}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("agent reminder request failed (network or timeout)");
  }
  if (!response.ok) throw new Error(`agent reminder request failed (${response.status})`);
  const result = (await response.json()) as ReminderResponse;
  if (fields.operation === "ack" || fields.operation === "dismiss") return result;
  // The daemon answers some reminder commands with a local shape — a seal/unseal result or a
  // sealed reminder's lifecycle refusal — which is not the cloud operation response and must
  // not go through its codec (a missing scope field would surface as "invalid reminder scope").
  const cloudShaped =
    Array.isArray((result as AgentReminderOperationResponse).reminders) &&
    Array.isArray((result as AgentReminderOperationResponse).events);
  if (!cloudShaped) return result;
  return decodeAgentReminderOperationResponse(
    encodeAgentReminderOperationResponse(result as AgentReminderOperationResponse),
  );
}
