import {
  chains,
  commands,
  current,
  supersededView,
  terminal,
  view,
  type AgentControlStore,
  type AgentControlView,
  type AgentRecoveryFields,
} from "./agent-control-types.server";
import type { AgentControlPublisher } from "./agent-control-publisher.server";
import type { AgentControlSignal } from "./agent-control-signal.server";

/** The signal key the receiver notifies when the Daemon acknowledges one control request
 * (`accepted:<requestId>`): scoped to the request so an unrelated wake on the Agent's own key
 * can never pass for this operation's acknowledgement. */
export const agentControlAcceptedKey = (requestId: string) => `accepted:${requestId}`;

/** Moves an operation along its command chain and waits for the Daemon's receipts. */
export class AgentControlDriver {
  constructor(
    private readonly store: AgentControlStore,
    private readonly publisher: AgentControlPublisher,
    private readonly signal: AgentControlSignal,
    private readonly timing: { timeoutMs: number; fallbackMs?: number },
  ) {}

  async advance(agentId: string, requestId: string, recovery?: AgentRecoveryFields) {
    const agent = await this.store.get(agentId);
    const state = agent?.state;
    if (!agent || !state || state.requestId !== requestId || !current(agent, state)) return;
    if (state.phase === "stopped" || state.phase === "workspace-reset") {
      const chain = chains[state.action];
      const completed = state.phase === "stopped" ? "stop" : "reset-workspace";
      let index = chain.indexOf(completed) + 1;
      const clearSession = chain[index] === "clear-session";
      if (clearSession) index++;
      const next = chain[index];
      if (next === "clear-session") throw new Error("Invalid Agent control chain");
      const { identity, launchId: _launch, ...fields } = state;
      // A chain step that moves into "starting" (e.g. Restart's stop -> start,
      // Reset session's stop -> clear-session -> start) mints a fresh launchId here, the moment
      // of the same phase transition `begin()` mints one for a direct `action: "start"` — never
      // carried forward from the step this operation just finished.
      const launchId = next === "start" ? crypto.randomUUID() : undefined;
      if (
        !(await this.store.replace(
          agent,
          {
            ...fields,
            phase: next ? commands[next].pending : "completed",
            sessionSequence: 0,
            ...(!clearSession && identity ? { identity } : {}),
            ...(launchId ? { launchId } : {}),
          },
          { clearSession },
        ))
      )
        return;
    }
    // Reaching this line without a store write above (phase already "starting"/"completed") is
    // a pure republish of the same command.
    await this.publisher.publishCurrent(agentId, requestId, recovery);
  }
  async drive(
    agentId: string,
    requestId: string,
    /** Only ever set by `execute()`'s `"start"` action; threaded into the single `publishCurrent`
     * call this method itself makes. Chain transitions still go through `advance()`; the Start
     * that ends a Restart/Reset/Full reset reads its own recovery in `publishCurrent`. */
    recovery?: AgentRecoveryFields,
    /** `execute()`'s bounded wait (task #584): `waitMs` replaces `timing.timeoutMs`, and
     * `untilAccepted` ends the wait on the Daemon's `accepted` acknowledgement as well as on a
     * terminal result. Absent keeps the terminal-only, `timeoutMs`-bounded wait. */
    options?: { waitMs?: number; untilAccepted?: boolean },
  ): Promise<AgentControlView> {
    const deadline = Date.now() + (options?.waitMs ?? this.timing.timeoutMs);
    let publishedPhase = "";
    // A signal means the ACK handler already advanced and published the next command.
    let signaled = false;
    // The Daemon's `accepted` acknowledgement for THIS request arrived; the operation itself
    // keeps running server-side, so the next state read answers the pending view.
    let acceptedSeen = false;
    for (;;) {
      const agent = await this.store.get(agentId);
      const state = agent?.state;
      // A genuine scope change (Agent moved Computer, config revision changed, Agent gone) is
      // still an error; a requestId that changed while the Agent's own scope is still current
      // means a newer command superseded this one — report that to the caller
      // instead of an error, since the newer command is the one actually running now.
      if (!agent || !state || !current(agent, state))
        throw new Error("Agent operation scope changed");
      if (state.requestId !== requestId) return supersededView(state);
      if (terminal(state)) return view(state);
      if (options?.untilAccepted && acceptedSeen) return view(state);
      if (state.phase === "stopped" || state.phase === "workspace-reset") {
        await this.advance(agentId, requestId);
        continue;
      }
      if (signaled) {
        signaled = false;
        publishedPhase = state.phase;
      }
      if (publishedPhase !== state.phase) {
        // Publish failure is ambiguous: keep the durable pending state and retry the SAME
        // request, UNLESS the failure happened because the request was superseded underneath us
        // in the meantime — re-read to tell the two apart instead of reporting the stale phase.
        try {
          await this.publisher.publishCurrent(agentId, requestId, recovery);
        } catch {
          const latest = await this.store.get(agentId);
          const latestState = latest?.state;
          if (
            latest &&
            latestState &&
            latestState.requestId !== requestId &&
            current(latest, latestState)
          )
            return supersededView(latestState);
          return view(state);
        }
        publishedPhase = state.phase;
        continue;
      }
      if (Date.now() >= deadline) return view(state);
      const slice = Math.min(this.timing.fallbackMs ?? 1_000, deadline - Date.now());
      if (options?.untilAccepted) {
        // The acknowledgement and an ordinary state-change wake are different signals: only
        // the request-scoped one ends the wait early. The slower key still wakes the loop for
        // chain advancement and terminal results exactly as before, and its timeout keeps the
        // `signaled` semantics the republish skip relies on.
        const winner = await Promise.race([
          this.signal.wait(agentId, slice).then((hit) => ({ kind: "agent" as const, hit })),
          this.signal
            .wait(agentControlAcceptedKey(requestId), slice)
            .then((hit) => ({ kind: "accepted" as const, hit })),
        ]);
        if (winner.kind === "accepted" && winner.hit) {
          acceptedSeen = true;
          continue;
        }
        signaled = winner.kind === "agent" ? winner.hit : false;
      } else {
        // Daemon ACKs wake the waiter; the fallback re-read bounds a lost signal.
        signaled = await this.signal.wait(agentId, slice);
      }
    }
  }
}
