import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentSession } from "@coforge/agent";
import { AntigravityAcpProvider } from "#src/antigravity/acp-provider";
import { ANTIGRAVITY_MAX_INPUT_BYTES } from "#src/antigravity/acp-session";
import { fixtureAntigravityHost } from "./fixtures/antigravity-host";

const command = [
  process.execPath,
  new URL("./fixtures/antigravity-acp.ts", import.meta.url).pathname,
];

async function withSession(
  body: (ctx: { session: AgentSession; events: AgentRuntimeEvent[] }) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-agy-input-limit-"));
  const provider = new AntigravityAcpProvider({
    acpTimeoutMs: 10_000,
    command,
    host: fixtureAntigravityHost,
  });
  try {
    const session = await provider.createAgentSession({
      agentWorkspaceDirectory: cwd,
      instructions: "standing instructions",
      runtime: { model: "gemini-4-carbon", reasoning: "high" },
    } as never);
    const events: AgentRuntimeEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await body({ session, events });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(15);
  }
  throw new Error("timed out waiting for condition");
}

const completed = (events: AgentRuntimeEvent[]) =>
  events.filter((event) => event.type === "completed");

test("accepts an input right at the 185,000-byte UTF-8 ceiling", async () => {
  expect(ANTIGRAVITY_MAX_INPUT_BYTES).toBe(185_000);
  await withSession(async ({ session, events }) => {
    await session.sendMessage("a".repeat(ANTIGRAVITY_MAX_INPUT_BYTES));
    await waitFor(() => completed(events).length === 1);
    expect(completed(events)[0]!.status).toBe("completed");
  });
});

test("rejects an input over 185,000 UTF-8 bytes before dispatch and keeps the session usable", async () => {
  await withSession(async ({ session, events }) => {
    await expect(session.sendMessage("a".repeat(ANTIGRAVITY_MAX_INPUT_BYTES + 1))).rejects.toThrow(
      /input is too large.*exceeds the maximum/i,
    );
    expect(events).toEqual([]);

    await session.sendMessage("hello");
    await waitFor(() => completed(events).length === 1);
    expect(completed(events)[0]!.status).toBe("completed");
  });
});

test("counts UTF-8 bytes rather than UTF-16 code units for multi-byte characters", async () => {
  await withSession(async ({ session, events }) => {
    const multibyte = "中".repeat(Math.floor(ANTIGRAVITY_MAX_INPUT_BYTES / 3) + 1);
    expect(multibyte.length).toBeLessThan(ANTIGRAVITY_MAX_INPUT_BYTES);
    expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(ANTIGRAVITY_MAX_INPUT_BYTES);

    await expect(session.sendMessage(multibyte)).rejects.toThrow(
      /input is too large.*exceeds the maximum/i,
    );
    expect(events).toEqual([]);
  });
});

test("rejects an oversized steer without disturbing the active turn", async () => {
  await withSession(async ({ session, events }) => {
    const first = session.sendMessage("held");
    await expect(session.sendMessage("a".repeat(ANTIGRAVITY_MAX_INPUT_BYTES + 1))).rejects.toThrow(
      /input is too large.*exceeds the maximum/i,
    );

    const steer = session.sendMessage("finish");
    await Promise.all([first, steer]);
    await waitFor(() => completed(events).length === 1);
    expect(completed(events)[0]!.status).toBe("completed");
  });
});
