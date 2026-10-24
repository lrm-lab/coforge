import type { AgentRuntimeEvent } from "@coforge/agent";
import { isActivityCallId } from "@lrm/coforge-sdk/internal";
import {
  REPLY_INTENT_MAX_LIVE_PER_AGENT,
  REPLY_INTENT_MAX_MS,
  REPLY_INTENT_PHASE,
  REPLY_INTENT_REFRESH_MS,
  type ReplyIntent,
} from "@lrm/coforge-sdk/internal/reply-intent";
import { sendMessageTarget } from "#src/code-agent/send-command-target";
import { scheduleUnrefInterval, type UnrefIntervalSchedule } from "./unref-timer";

/** One "about to post" signal for a tool call. A start carries the Agent's raw send target and an
 * end repeats it, so the server routes both the same way. */
export type ReplyIntentSignal = Pick<ReplyIntent, "phase" | "callId" | "target" | "early">;

export type ReplyIntentTrackerPorts = Readonly<{
  /** Best effort and fire-and-forget; nothing waits for it. */
  emit(signal: ReplyIntentSignal): void;
  now?(): number;
  every?: UnrefIntervalSchedule;
}>;

type LiveCall = {
  target: string;
  /** The target was known before the call's arguments finished streaming. */
  early: boolean;
  /** The provider has reported the call itself, not only its streaming arguments. */
  started: boolean;
  announcedAtMs: number;
};

/**
 * One launch's "about to post" signals, from the provider's raw tool events: a call that sends a
 * message announces its target as soon as the provider shows it (`reply-intent`, while the model
 * is still writing the call) or else when the call starts (`tool-start`), repeats the start every
 * refresh period while it runs, and ends when the call does, the turn completes, the launch goes
 * away or it has been announced for two minutes. The call that starts is the truth: an early
 * announcement whose finished call has another target, or none, is ended (and restarted with the
 * real target). One the model abandoned before the call began is ended when the provider says so
 * (`reply-intent-retracted`). The browser's deadline is longer than a refresh period, so a missed
 * repeat costs nothing and a missed end only lasts until that deadline.
 *
 * An observation, not a delivery: signals are never queued or retried, a sink that fails is
 * ignored, and at most `REPLY_INTENT_MAX_LIVE_PER_AGENT` calls are announced at once.
 */
export class ReplyIntentTracker {
  readonly #emit: ReplyIntentTrackerPorts["emit"];
  readonly #now: () => number;
  readonly #every: UnrefIntervalSchedule;
  readonly #live = new Map<string, LiveCall>();
  /** The one repeating timer, running only while a call is live. */
  #stopTimer: (() => void) | undefined;
  #disposed = false;

  constructor(ports: ReplyIntentTrackerPorts) {
    this.#emit = ports.emit;
    this.#now = ports.now ?? Date.now;
    this.#every = ports.every ?? scheduleUnrefInterval;
  }

  observe(event: AgentRuntimeEvent): void {
    if (this.#disposed) return;
    if (event.type === "reply-intent") this.#start(event.id, event.target, true, false);
    else if (event.type === "reply-intent-retracted") this.#retract(event.id);
    else if (event.type === "tool-start") this.#startFinished(event);
    else if (event.type === "tool-end") this.#end(event.id);
    else if (event.type === "completed") for (const callId of this.#live.keys()) this.#end(callId);
  }

  /** The launch is going away: every live call ends and nothing more is announced. */
  dispose(): void {
    for (const callId of this.#live.keys()) this.#end(callId);
    this.#disposed = true;
  }

  /** The provider reported the call itself; it settles what an early announcement guessed. */
  #startFinished(event: Extract<AgentRuntimeEvent, { type: "tool-start" }>): void {
    const live = this.#live.get(event.id);
    if (!live && this.#live.size >= REPLY_INTENT_MAX_LIVE_PER_AGENT) return;
    const target = sendMessageTarget(event);
    if (!live) {
      if (target) this.#start(event.id, target, false, true);
      return;
    }
    live.started = true;
    if (target === live.target) return;
    this.#end(event.id);
    if (target) this.#start(event.id, target, false, true);
  }

  #retract(callId: string): void {
    const live = this.#live.get(callId);
    if (live?.early && !live.started) this.#end(callId);
  }

  #start(callId: string, target: string, early: boolean, started: boolean): void {
    if (this.#live.has(callId) || this.#live.size >= REPLY_INTENT_MAX_LIVE_PER_AGENT) return;
    if (!isActivityCallId(callId)) return;
    const call = { target, early, started, announcedAtMs: this.#now() };
    this.#live.set(callId, call);
    this.#stopTimer ??= this.#every(() => this.#repeat(), REPLY_INTENT_REFRESH_MS);
    this.#emitStart(callId, call);
  }

  #repeat(): void {
    const at = this.#now();
    for (const [callId, call] of this.#live) {
      if (at - call.announcedAtMs >= REPLY_INTENT_MAX_MS) this.#end(callId);
      else this.#emitStart(callId, call);
    }
  }

  #end(callId: string): void {
    const call = this.#live.get(callId);
    if (!call) return;
    this.#live.delete(callId);
    if (this.#live.size === 0) {
      this.#stopTimer?.();
      this.#stopTimer = undefined;
    }
    this.#send({ phase: REPLY_INTENT_PHASE.END, callId, target: call.target });
  }

  #emitStart(callId: string, call: LiveCall): void {
    this.#send({
      phase: REPLY_INTENT_PHASE.START,
      callId,
      target: call.target,
      ...(call.early ? { early: true } : {}),
    });
  }

  #send(signal: ReplyIntentSignal): void {
    try {
      this.#emit(signal);
    } catch {
      // An observation never fails Agent work.
    }
  }
}
