import { afterEach, expect, setSystemTime, test } from "bun:test";
import type { AgentSession } from "@lrm/coforge-anvil";
import type { AgentMessageDelivery } from "@lrm/coforge-sdk/internal";
import type { AgentRestartConfig } from "#src/agent-runtime/agent-process-manager";
import { AgentDeliveryGate } from "#src/daemon-runtime/agent-delivery-gate";
import { LaunchInboxes } from "#src/daemon-runtime/launch-inbox";
import { NoticeActionClocks } from "#src/daemon-runtime/notice-action-clocks";
import type { RuntimeReleasePorts } from "#src/daemon-runtime/runtime-release";
import { stalledRuntime } from "#src/daemon-runtime/runtime-release-stalled";
import {
  ProviderProgress,
  STALLED_RECOVERY_SILENCE_MS,
} from "#src/daemon-runtime/stalled-recovery";

// A machine that sleeps freezes its Agents with it: the stall judgment's ages are awake time, so
// the minutes slept through never count toward a fuse. Each case sleeps 20 minutes (the wall
// clock passes the 15-minute fuse, the awake clock moves seconds), then lets the awake clock
// itself reach the fuse.

type Launch = { stopping: boolean; progress: ProviderProgress };

const START = new Date("2026-11-16T00:00:00.000Z");
const SLEEP_MS = 20 * 60_000;

afterEach(() => setSystemTime());

const queued = (id: string): AgentMessageDelivery => ({
  protocolMajor: 1,
  requestId: `request-${id}`,
  messageId: `message-${id}`,
  deliveryId: `delivery-${id}`,
  sequence: 1,
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  agentId: "agent-a",
  body: "body",
  method: "agent:v1:message:deliver",
  target: "@ada",
});

function subject(options: { busyTurn: boolean }) {
  setSystemTime(START);
  let awakeMs = 0;
  const awake = () => awakeMs;
  const progress = new ProviderProgress(undefined, awake);
  const launch: Launch = { stopping: false, progress };
  const clocks = new NoticeActionClocks(awake);
  const gate = new AgentDeliveryGate(new LaunchInboxes(awake));
  const session = {
    hasLiveTurn: options.busyTurn,
    steersBusyTurn: true,
  } as unknown as AgentSession;
  const restart: AgentRestartConfig = {
    config: { provider: "pi", model: "m", modelProvider: "anthropic", reasoning: "balanced" },
    sessionId: "native-1",
  };
  const ports: RuntimeReleasePorts<Launch> = {
    launch: () => launch,
    runtime: () => ({ session }) as never,
    restartConfig: () => restart,
    lastBusy: () =>
      options.busyTurn
        ? ({ launch, activity: { detail: "working" }, at: START.getTime() } as never)
        : undefined,
    queuedForMs: (agentId) => gate.queuedForMs(agentId),
    // Whether the notice started the turn (its absolute time against the turn's start) is task
    // #14's judgment; here only the ages are under test.
    noticeAcceptedForMs: (agentId) => clocks.noticeAcceptedForMs(agentId),
    lastAgentActionForMs: (agentId) => clocks.lastAgentActionForMs(agentId),
    resumable: () => true,
    sessionId: () => "native-1",
    isStopping: () => false,
    daemonIdleFacts: () => ({}) as never,
    hasParkedWork: () => true,
    flushParked: () => {},
    takeParked: () => [],
    wake: async () => {},
    publish: () => {},
    carryMentions: () => new Map(),
    abortMentionCarry: () => {},
    release: async () => {},
  };
  return {
    stalled: () => stalledRuntime(ports, "agent-a"),
    clocks,
    gate,
    /** The machine sleeps: the wall clock passes `ms`, the awake clock a few seconds. */
    sleep(ms: number) {
      setSystemTime(new Date(Date.now() + ms));
      awakeMs += 5_000;
    },
    /** The Agent's awake time passes. */
    stayAwake(ms: number) {
      setSystemTime(new Date(Date.now() + ms));
      awakeMs += ms;
    },
  };
}

test("a busy turn silent across a sleep is not stalled, and is once it stays silent awake", () => {
  const h = subject({ busyTurn: true });
  h.sleep(SLEEP_MS);
  expect(h.stalled()).toBeUndefined();
  h.stayAwake(STALLED_RECOVERY_SILENCE_MS);
  expect(h.stalled()?.basis).toMatchObject({ reason: "silent_turn" });
});

test("a delivery queued across a sleep never started its turn only once it waited that long awake", () => {
  const h = subject({ busyTurn: false });
  h.gate.enqueue("agent-a", queued("one"));
  h.sleep(SLEEP_MS);
  expect(h.stalled()).toBeUndefined();
  h.stayAwake(STALLED_RECOVERY_SILENCE_MS);
  expect(h.stalled()?.basis).toMatchObject({ reason: "queued_turn_never_started" });
});

test("a notice accepted before a sleep is frozen only once the Agent stayed quiet that long awake", () => {
  const h = subject({ busyTurn: false });
  // The Agent took the notice a moment after its last provider output.
  h.stayAwake(1_000);
  h.clocks.noteNoticeAccepted("agent-a");
  h.sleep(SLEEP_MS);
  expect(h.stalled()).toBeUndefined();
  h.stayAwake(STALLED_RECOVERY_SILENCE_MS);
  expect(h.stalled()?.basis).toMatchObject({ reason: "noticed_but_frozen" });
});
