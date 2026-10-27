import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import type { AgentRuntimeEvent } from "@lrm/coforge-anvil";
import {
  firstProgress,
  nthCompleted,
  nthTurn,
  withSession,
} from "./fixtures/opencode-session-harness";

test("input queued while a turn runs is joined into the next turn's prompt", async () => {
  await withSession(
    {
      sessionId: "session-existing",
      environment: { COFORGE_OPENCODE_TURN_DELAY_MS: "150" },
    },
    async ({ session, launches }) => {
      const both = nthCompleted(session, 2);
      // The first turn counts as running from the moment it is spawned, so the next two queue.
      await session.sendMessage("first");
      await Promise.all([session.sendMessage("second"), session.notify!("third")]);
      await both;
      const [first, second, ...rest] = await launches();
      expect(rest).toEqual([]);
      expect(first?.prompt).toBe("first");
      expect(second).toMatchObject({ prompt: "second\n\nthird", resumeId: "session-existing" });
    },
  );
}, 20_000);

test("interrupting a running turn ends it as interrupted and leaves the session usable", async () => {
  await withSession(
    { sessionId: "session-existing", environment: { COFORGE_OPENCODE_MODE: "hang" } },
    async ({ session, launches }) => {
      const events: AgentRuntimeEvent[] = [];
      session.subscribe((event) => events.push(event));
      for (let turn = 1; turn <= 2; turn += 1) {
        const running = firstProgress(session);
        const completed = nthCompleted(session, 1);
        await session.sendMessage("go");
        await running;
        await session.interrupt();
        await completed;
      }
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(events.filter((event) => event.type === "completed")).toEqual([
        { type: "completed", status: "interrupted" },
        { type: "completed", status: "interrupted" },
      ]);
      expect(await launches()).toHaveLength(2);
    },
  );
}, 20_000);

test("dispose kills a running turn and rejects queued input", async () => {
  await withSession(
    { sessionId: "session-existing", environment: { COFORGE_OPENCODE_MODE: "hang" } },
    async ({ session }) => {
      let exited = false;
      session.onExit(() => {
        exited = true;
      });
      const running = firstProgress(session);
      await session.sendMessage("go");
      await running;
      const queued = session.notify!("queued while disposing");
      // Mark the rejection handled at once, so it never surfaces as unhandled before the assertion.
      queued.catch(() => undefined);
      await session.dispose();
      expect(exited).toBe(true);
      await expect(queued).rejects.toThrow("code agent session was disposed");
      await expect(session.sendMessage("after dispose")).rejects.toThrow(
        "code agent session is disposed",
      );
    },
  );
}, 20_000);

test("a turn that cannot be spawned rejects the input and leaves the session idle", async () => {
  await withSession({ sessionId: "session-existing" }, async ({ session, launches, directory }) => {
    // Bun.spawn throws synchronously for a working directory that does not exist.
    await rm(directory, { recursive: true });
    await expect(session.sendMessage("first")).rejects.toThrow("ENOENT");

    // The failed spawn did not leave the session "running": the next input starts a turn.
    await mkdir(directory);
    await nthTurn(session, "second");
    expect(await launches()).toEqual([
      expect.objectContaining({ prompt: "second", resumeId: "session-existing" }),
    ]);
  });
}, 5_000);

test("a resumed session reports its id when each turn completes, and only then", async () => {
  await withSession({ sessionId: "session-existing" }, async ({ session, reports }) => {
    await nthTurn(session, "one");
    expect(await session.readSessionIdentity!()).toEqual({
      sessionId: "session-existing",
      state: "resumable",
    });
    await nthTurn(session, "two");
    expect(reports).toEqual([{ sessionId: "session-existing" }, { sessionId: "session-existing" }]);
  });
}, 20_000);

test("a fresh session reports the id its first event named, then again as each turn completes", async () => {
  await withSession(
    { environment: { COFORGE_OPENCODE_SESSION_ID: "session-fresh" } },
    async ({ session, reports }) => {
      await nthTurn(session, "one");
      expect(reports).toEqual([{ sessionId: "session-fresh" }, { sessionId: "session-fresh" }]);
      await nthTurn(session, "next");
      expect(reports).toHaveLength(3);
    },
  );
}, 20_000);

test("a session whose first turn failed after naming it stays unknown, and a repeat of its id is not reported", async () => {
  await withSession(
    {
      environment: { COFORGE_OPENCODE_MODE: "crash", COFORGE_OPENCODE_SESSION_ID: "session-half" },
    },
    async ({ session, reports }) => {
      await nthTurn(session, "first");
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: "session-half",
        state: "empty",
      });
      // The next turn repeats the id the session already has: it is not re-derived (the session
      // never completed a turn, yet stays "unknown" as the resume marked it) and not re-reported.
      await nthTurn(session, "again");
      expect(await session.readSessionIdentity!()).toEqual({
        sessionId: "session-half",
        state: "unknown",
      });
      expect(reports).toEqual([{ sessionId: "session-half" }]);
    },
  );
}, 20_000);
