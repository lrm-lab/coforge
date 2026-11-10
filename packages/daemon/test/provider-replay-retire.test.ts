import { afterAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { connection, harness } from "./fixtures/provider-replay-harness";

afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));

type Harness = Awaited<ReturnType<typeof harness>>;

/** Message 1 is in flight in the old session (its notice is held), so the old input drain is busy
 * and whatever is queued next waits behind it. */
async function inFlight(h: Harness) {
  // A real session is mid-turn once it accepts a notice, so a turn's end does not release holds.
  h.liveTurn(true);
  const open = h.gateNotices();
  const telling = h.deliver(1).catch(() => {});
  await h.until(() => h.sessions[0]!.notices.some((notice) => notice.includes("#general")));
  return { open, telling };
}

/** Rejects the old session's replay and waits for the cold start's first notice. */
async function replace(h: Harness, open: () => void) {
  h.failTurn(h.sessions[0]!);
  await h.until(() => h.sessions.length === 2);
  open();
  await h.until(() => h.sessions[1]!.notices.length > 1);
}

const told = (h: Harness, text: string) =>
  h.sessions[1]!.notices.filter((notice) => notice.includes(text));

test("a tracked mention waiting in the ended runtime's queue is carried and told once by the fresh session", async () => {
  const h = await harness({ resume: "stored-1" });
  const { open, telling } = await inFlight(h);
  try {
    const waiting = h.deliver(2, h.envelope(2, "stored-1")).catch(() => {});
    await replace(h, open);
    await Promise.all([telling, waiting]);
    const own = () =>
      told(h, "CoForge inbox notice").filter((notice) => !notice.includes("--unread"));
    await h.until(() => own().length > 0);

    // Not handed back for the server to issue again: the fresh session is told it, once.
    expect(h.terminalErrors).toEqual([]);
    expect(own()).toHaveLength(1);
  } finally {
    open();
    await h.runtime.stop();
  }
});

test("an ordinary delivery waiting in the ended runtime's queue is told once", async () => {
  const h = await harness({ resume: "stored-1" });
  const { open, telling } = await inFlight(h);
  try {
    const waiting = h.deliver(2).catch(() => {});
    await replace(h, open);
    await Promise.all([telling, waiting]);

    const notices = h.sessions[1]!.notices.filter((notice) => notice.includes("#general"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("#general 2 new messages");
  } finally {
    open();
    await h.runtime.stop();
  }
});
