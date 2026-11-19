import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentSession } from "@coforge/agent";
import { AntigravityAcpProvider } from "#src/antigravity/acp-provider";
import { fixtureAntigravityHost } from "./fixtures/antigravity-host";

const command = [
  process.execPath,
  new URL("./fixtures/antigravity-acp.ts", import.meta.url).pathname,
];

async function withSession(
  body: (ctx: { session: AgentSession; events: AgentRuntimeEvent[] }) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "anvil-agy-steer-"));
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

test("a steered prompt failing with an RPC quota error fails the merged turn with window_limit", async () => {
  await withSession(async ({ session, events }) => {
    const first = session.sendMessage("held");
    const steer = session.sendMessage("rpc-quota-error");
    await Promise.all([first, steer]);
    await waitFor(() => completed(events).length > 0);
    expect(completed(events).map((e) => e.status)).toEqual(["failed"]);
    expect(events.some((e) => e.type === "notice-undelivered")).toBe(false);
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.providerLimit?.kind).toBe("window_limit");
    expect(errors[0]!.providerLimit?.resetsAt).toBeDefined();
  });
});

test("a steered prompt rejected with -32602 reports notice-undelivered without failing the turn", async () => {
  await withSession(async ({ session, events }) => {
    const first = session.sendMessage("held");
    const steer = session.sendMessage("rpc-invalid-params");
    await Promise.all([first, steer]);
    await waitFor(() => completed(events).length > 0);
    expect(events.some((e) => e.type === "notice-undelivered")).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(completed(events).map((e) => e.status)).toEqual(["completed"]);
  });
});

test("a steered prompt ending with an in-band quota warning fails the merged turn", async () => {
  await withSession(async ({ session, events }) => {
    const first = session.sendMessage("held-silent");
    const steer = session.sendMessage("inband-quota-delayed");
    await Promise.all([first, steer]);
    await waitFor(() => completed(events).length > 0);
    expect(completed(events).map((e) => e.status)).toEqual(["failed"]);
    const errors = events.filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]!.providerLimit?.kind).toBe("window_limit");
  });
});

test("a steered prompt stopping with max_tokens fails the merged turn without notice-undelivered", async () => {
  await withSession(async ({ session, events }) => {
    const first = session.sendMessage("held");
    const steer = session.sendMessage("max-tokens");
    await Promise.all([first, steer]);
    await waitFor(() => completed(events).length > 0);
    expect(events.some((e) => e.type === "notice-undelivered")).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(completed(events).map((e) => e.status)).toEqual(["failed"]);
  });
});
