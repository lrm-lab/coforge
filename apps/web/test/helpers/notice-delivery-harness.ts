import type { WakeHint } from "@lrm/coforge-sdk/agent";
import { ExternalInboxNoticeDelivery } from "#src/server/agents/external-inbox-notice-delivery.server";
import { pushWebhookSealer } from "#src/server/agents/external-push-webhook-secret.server";
import { MemoryPushWebhookStore } from "./memory-push-webhook-store";

export const SECRET = "c".repeat(64);
export const NOW = new Date("2026-11-17T12:00:00Z");
export const hint: WakeHint = {
  target: "#general",
  channelId: "c1",
  channelType: "channel",
  pendingCount: 3,
  firstPendingMsgId: "m1",
  latestMsgId: "m3",
  latestSeq: "9",
  latestSenderName: "ada",
  latestSenderType: "human",
  flags: ["mention"],
};

export type Sent = { url: string; headers: Record<string, string>; body: string };

export async function setup(
  respond: () => { status: number; retryAfter?: string } | Error,
  over: { hints?: WakeHint[]; agent?: Parameters<MemoryPushWebhookStore["addAgent"]>[1] } = {},
) {
  const store = new MemoryPushWebhookStore();
  store.addAgent("a1", over.agent);
  const sealer = pushWebhookSealer(new Uint8Array(32).fill(3));
  await store.save({
    agentId: "a1",
    workspaceId: "w1",
    url: "https://hooks.example/inbox",
    secretSealed: await sealer.seal("a1", SECRET),
  });
  const sent: Sent[] = [];
  const rescheduled: { agentId: string; noticeId: string; delaySeconds: number }[] = [];
  const probes: { agentId: string; delaySeconds: number }[] = [];
  const announced: string[] = [];
  const clock = { at: NOW };
  let ids = 0;
  const delivery = new ExternalInboxNoticeDelivery(store, {
    egress: {
      sendToAny: async (url, request) => {
        sent.push({ url, headers: request.headers ?? {}, body: String(request.body) });
        const outcome = respond();
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
    sealer: async () => sealer,
    listHints: async () => over.hints ?? [hint],
    reschedule: async (agentId, noticeId, delaySeconds) => {
      rescheduled.push({ agentId, noticeId, delaySeconds });
    },
    scheduleProbe: async (agentId, delaySeconds) => {
      probes.push({ agentId, delaySeconds });
    },
    announce: async (agentId) => {
      announced.push(agentId);
    },
    newId: () => `probe-${++ids}`,
    now: () => clock.at,
  });
  return {
    store,
    sent,
    rescheduled,
    probes,
    announced,
    clock,
    run: (noticeId = "n1") => delivery.deliver({ agentId: "a1", noticeId }),
    probe: () => delivery.deliver({ agentId: "a1", probe: true }),
  };
}
