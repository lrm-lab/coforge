import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentRuntimeEvent, AgentSession } from "@lrm/coforge-anvil";
import { scenarioProvider, waitForEvent } from "./codex-scenarios";

/** Room for the fixture's held `turn/start` reply, which outlasts the shared default budget. */
const heldTurnAttempts = 1_000;

// An interrupt loses two races (task #703). Both leave the session claiming a turn it no longer
// has, so the daemon keeps an Agent busy that is idle: it reports a live turn, refuses the next
// message as "already running", and a later notice may clear it by luck.

let directory: string;
/** Every request the fake app-server received, in order, for the sequencing assertions. */
let requestLog: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "coforge-codex-interrupt-"));
  requestLog = join(directory, "requests.jsonl");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function openSession(): Promise<{ session: AgentSession; events: AgentRuntimeEvent[] }> {
  const session = await scenarioProvider(`log=${requestLog}`).createAgentSession({
    agentWorkspaceDirectory: directory,
    instructions: "Test.",
  });
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { session, events };
}

/** The methods the fake app-server was asked for, in the order it received them. */
async function methods(): Promise<string[]> {
  const text = await readFile(requestLog, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { method?: string }).method ?? "");
}

test("an interrupt that loses to its own turn's completion does not revive the turn", async () => {
  const { session, events } = await openSession();
  try {
    await session.sendMessage("interrupt-after-completion");
    await waitForEvent(events, "thinking-delta");
    // codex answers the interrupt with an error, but its turn already completed: the session is
    // idle, and must not report a live turn it can never finish.
    await session.interrupt().catch(() => undefined);
    expect(session.hasLiveTurn).toBe(false);
    // The proof a reader cares about: the next message is accepted rather than refused, and its
    // own turn runs to completion.
    events.length = 0;
    await session.sendMessage("finish");
    await waitForEvent(events, "completed");
  } finally {
    await session.dispose();
  }
});

test("an interrupt while the turn is starting is sent once the turn begins", async () => {
  const { session, events } = await openSession();
  try {
    // `turn/start` is answered only after a long beat, so this interrupt arrives while the
    // session still waits for the turn id. Dropping it lets the turn run on against the user's
    // stop: no `completed` would ever arrive, because only an interrupt ends this turn.
    const sending = session.sendMessage("interrupt-while-starting");
    await Bun.sleep(100);
    expect(session.hasLiveTurn).toBe(true);
    await session.interrupt();
    await Promise.all([sending, waitForEvent(events, "completed", heldTurnAttempts)]);
    expect(session.hasLiveTurn).toBe(false);
    // The interrupt reached the app-server, and could only do so after it knew the turn id: no
    // `turn/interrupt` can be sent before the `turn/start` reply.
    const received = await methods();
    expect(received).toContain("turn/start");
    expect(received).toContain("turn/interrupt");
    expect(received.indexOf("turn/interrupt")).toBeGreaterThan(received.indexOf("turn/start"));
  } finally {
    await session.dispose();
  }
});
