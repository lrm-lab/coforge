/**
 * How long the Daemon's cloud connection may carry nothing at all before CoForge stops believing
 * it. An open socket is not evidence: the connection that prompted this stayed open, kept its
 * subscription, and delivered frames the Daemon could not act on, while the Agent behind it sat
 * silent until someone restarted the Computer by hand.
 *
 * Inbound traffic here means anything that proves the link still carries data in both
 * directions - a publication on the Daemon's own channel, or a reply to the status RPC the
 * connection already sends every 30 seconds. A Workspace with nothing to say still produces the
 * second, so a quiet Workspace is never mistaken for a dead connection.
 */
export const INBOUND_QUIET_MS = 70_000;

/** When a connection has carried nothing for this long, it is rebuilt rather than waited on.
 * Four consecutive 30-second status round trips have to go unanswered before the fifth refresh
 * finds this window crossed, so a connection is never rebuilt over a single lost reply. The
 * relationship to that interval is asserted in `connection-liveness.test.ts`, because these
 * windows are only meaningful in refreshes. */
export const INBOUND_STALLED_MS = 140_000;

export type ConnectionLiveness = "carrying" | "quiet" | "stalled";

/** What the Daemon should make of a connection whose last inbound traffic was this long ago. */
export function connectionLiveness(lastInboundAgeMs: number): ConnectionLiveness {
  if (lastInboundAgeMs >= INBOUND_STALLED_MS) return "stalled";
  if (lastInboundAgeMs >= INBOUND_QUIET_MS) return "quiet";
  return "carrying";
}

import type { CentrifugeWorkspaceClient } from "./centrifuge-workspace-client";
import type { DaemonConnectionConfig } from "./daemon-connection-client";
import { getLogger } from "@logtape/logtape";

const livenessLogger = getLogger(["coforge", "daemon", "connection"]);

/**
 * Whether the connection still looks fed. A socket that stays open is not evidence anything
 * reaches this Daemon: the incident this answers kept its socket and its subscription while every
 * control frame it delivered was dropped as undecodable, and the Agent behind it stayed silent
 * until a person restarted the Computer. Rebuilding the connection is the one recovery that does
 * not need that person.
 */
export class InboundQuietness {
  #lastInboundAtMs: number | undefined;
  #loggedInboundQuiet = false;

  constructor(private readonly nowMs: () => number = Date.now) {}

  /** Fresh traffic arrived; the quiet log may say so again next window. */
  markInbound(): void {
    this.#lastInboundAtMs = this.nowMs();
    this.#loggedInboundQuiet = false;
  }

  /** Once per status refresh: quiet logs once, stalled rebuilds the connection. */
  check(client: CentrifugeWorkspaceClient, config: DaemonConnectionConfig): void {
    if (this.#lastInboundAtMs === undefined) return;
    const ageMs = this.nowMs() - this.#lastInboundAtMs;
    const liveness = connectionLiveness(ageMs);
    if (liveness === "carrying") return;
    const scope = { workspace_id: config.workspaceId, computer_id: config.computerId };
    if (liveness === "quiet") {
      if (this.#loggedInboundQuiet) return;
      this.#loggedInboundQuiet = true;
      livenessLogger.info("Daemon cloud connection has carried nothing recently", {
        event: "daemon_connection:inbound_quiet",
        ...scope,
        last_inbound_age_ms: ageMs,
        rebuild_after_ms: INBOUND_STALLED_MS,
      });
      return;
    }
    livenessLogger.warning("Daemon cloud connection carried nothing; rebuilding it", {
      event: "daemon_connection:inbound_stalled",
      ...scope,
      last_inbound_age_ms: ageMs,
      outcome: "reconnecting",
    });
    // Counts as fresh traffic so a connection that takes a while to come back is rebuilt once
    // per window rather than on every refresh while it reconnects.
    this.markInbound();
    client.disconnect();
    client.connect();
  }
}
