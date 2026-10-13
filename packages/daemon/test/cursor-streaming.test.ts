import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentSession } from "@coforge/agent";
import { CursorProvider } from "#src/code-agent/cursor/provider";
import { PROCESS_TREE_EXIT_GRACE_MS } from "#src/code-agent/process-tree-cleanup";
import { withDeadline } from "#src/code-agent/deadline";

const fixture = new URL("./fixtures/cursor-agent-fixture.ts", import.meta.url).pathname;
const provider = () => new CursorProvider({ command: [process.execPath, fixture] });
const FIRST_TEXT_BUDGET_MS = 5_000;
const text = (events: AgentRuntimeEvent[]) =>
  events.flatMap((event) => (event.type === "text-delta" ? [event.text] : [])).join("");

for (const interrupt of [false, true])
  test(
    `Cursor sends text before a gated tool boundary and ${interrupt ? "interrupts without a flush" : "finishes without duplicate flushes"}`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "cursor-streaming-"));
      try {
        const blocked = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch() {
            blocked.resolve();
            await release.promise;
            return new Response("released");
          },
        });
        let session: AgentSession | undefined;
        const events: AgentRuntimeEvent[] = [];
        const completed = Promise.withResolvers<void>();
        const firstText = Promise.withResolvers<void>();
        try {
          session = await provider().createAgentSession({
            agentWorkspaceDirectory: root,
            instructions: "Fixture instructions",
            sessionId: "existing-session",
            environment: {
              COFORGE_CURSOR_MODE: "partial-output",
              COFORGE_CURSOR_STREAM_GATE: `http://127.0.0.1:${server.port}`,
            },
          });
          session.subscribe((event) => {
            events.push(event);
            if (event.type === "completed") completed.resolve();
            if (event.type === "text-delta" && text(events) === "Reading Reading fixture now.")
              firstText.resolve();
          });
          await session.sendMessage("Read the fixture");
          await blocked.promise;
          // HTTP and stdout are independent channels; await the public text event too, while the
          // fixture's tool boundary is still held. A missing partial-output flag cannot satisfy it.
          await withDeadline(
            firstText.promise,
            FIRST_TEXT_BUDGET_MS,
            () => new Error("No text before the held tool boundary"),
          );
          expect(text(events)).toBe("Reading Reading fixture now.");
          expect(session.hasLiveTurn).toBe(true);
          expect(events.some((event) => event.type === "completed")).toBe(false);
          if (interrupt) await session.interrupt!();
          else release.resolve();
          await completed.promise;
          expect(text(events)).toBe(
            interrupt
              ? "Reading Reading fixture now."
              : "Reading Reading fixture now.Fixture read complete.",
          );
          expect(events.filter((event) => event.type === "tool-start")).toHaveLength(
            interrupt ? 0 : 1,
          );
          expect(events.filter((event) => event.type === "tool-end")).toHaveLength(
            interrupt ? 0 : 1,
          );
          expect(events.at(-1)).toEqual({
            type: "completed",
            status: interrupt ? "interrupted" : "completed",
          });
        } finally {
          release.resolve();
          try {
            await session?.dispose();
          } finally {
            await server.stop(true);
          }
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    2 * FIRST_TEXT_BUDGET_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS,
  );

test.each([
  ["partial output", "cursor-turn-partial.jsonl", "Reading fixture now.Fixture read complete.", 1],
  [
    "buffered output",
    "cursor-turn-fresh.jsonl",
    "I'll run `echo hi` and check for `probe.txt`.done",
    2,
  ],
] as const)(
  "native Cursor %s forwards each text segment once across tools and turn end",
  async (_mode, captureFile, expectedText, expectedTools) => {
    const root = await mkdtemp(join(tmpdir(), "cursor-native-replay-"));
    try {
      const session = await provider().createAgentSession({
        agentWorkspaceDirectory: root,
        instructions: "Fixture instructions",
        sessionId: "existing-session",
        environment: {
          COFORGE_CURSOR_MODE: "replay",
          COFORGE_CURSOR_REPLAY_FILE: new URL(`./fixtures/${captureFile}`, import.meta.url)
            .pathname,
        },
      });
      try {
        const events: AgentRuntimeEvent[] = [];
        const completed = Promise.withResolvers<void>();
        session.subscribe((event) => {
          events.push(event);
          if (event.type === "completed") completed.resolve();
        });
        await session.sendMessage("Read the fixture");
        await completed.promise;
        expect(text(events)).toBe(expectedText);
        expect(events.filter((event) => event.type === "text-delta")).toHaveLength(2);
        expect(events.filter((event) => event.type === "tool-start")).toHaveLength(expectedTools);
        expect(events.filter((event) => event.type === "tool-end")).toHaveLength(expectedTools);
        expect(events.at(-1)).toEqual({ type: "completed", status: "completed" });
      } finally {
        await session.dispose();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  5_000 + 2 * PROCESS_TREE_EXIT_GRACE_MS,
);
