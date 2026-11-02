import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { VERSION_PROBE_TIMEOUT_MS, PROCESS_TREE_EXIT_GRACE_MS } from "@lrm/coforge-anvil";
import { ACP_TIMEOUT_MS } from "#src/grok/session";
import { grokProvider } from "./grok-host";

export const FIXTURE = new URL("./grok-acp-fixture.ts", import.meta.url).pathname;

export const sessionTestBudgetMs = (acpTimeoutMs: number) =>
  VERSION_PROBE_TIMEOUT_MS + acpTimeoutMs + 2 * PROCESS_TREE_EXIT_GRACE_MS;
export const BUDGET = sessionTestBudgetMs(ACP_TIMEOUT_MS);
/** A test that waits out an ACP deadline gives its session this one instead of production's. It
 * still bounds `open()` against a freshly spawned fixture, so it leaves room for that start. */
export const SHORT_ACP_TIMEOUT_MS = 1_500;

/** A fixture session in its own workspace; `close` disposes it and removes the workspace. */
export async function openFixtureSession(
  options: Partial<AgentSessionOptions> = {},
  acpTimeoutMs?: number,
) {
  const workspace = await mkdtemp(join(tmpdir(), "grok-acp-"));
  const log = join(workspace, "rpc.jsonl");
  const close = async (session?: AgentSession) => {
    await session?.dispose();
    await rm(workspace, { recursive: true, force: true });
  };
  try {
    const session = await grokProvider({
      command: [process.execPath, FIXTURE],
      acpTimeoutMs,
    }).createAgentSession({
      agentWorkspaceDirectory: workspace,
      instructions: "instructions",
      environment: { COFORGE_GROK_ACP_LOG: log },
      ...options,
    });
    return { log, session, close: () => close(session) };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Every JSON-RPC message the fixture received from the client, in order. */
export const readRpcLog = async (log: string) =>
  (await Bun.file(log).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

/** Resolves on the session's next `completed` event. */
export function nextCompleted(session: AgentSession) {
  const done = Promise.withResolvers<void>();
  const off = session.subscribe((event) => {
    if (event.type === "completed") done.resolve();
  });
  return done.promise.finally(off);
}
