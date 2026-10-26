import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, AgentSessionOptions } from "@coforge/agent";
import { antigravityProvider } from "./antigravity-host";
import {
  type AgentRuntimeEvent,
  PROCESS_TREE_EXIT_GRACE_MS,
  VERSION_PROBE_TIMEOUT_MS,
} from "@lrm/coforge-anvil";

const FIXTURE = new URL("./antigravity-fixture.ts", import.meta.url).pathname;
export const INSTRUCTIONS = "Standing Antigravity instructions.";
/** Each test runs the session's version probe, then turns of the fake agy that may end through
 * process cleanup ladder. */
export const SESSION_BUDGET_MS = VERSION_PROBE_TIMEOUT_MS + 2 * PROCESS_TREE_EXIT_GRACE_MS;

type Launch = { prompt: string; model?: string; conversation?: string };

async function readLaunches(log: string): Promise<Launch[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Launch);
}

/** Resolves once `session` has emitted its Nth `completed` event. Registered before the input
 * that triggers it so no event can be missed to a race. */
export function nthCompleted(session: AgentSession, n: number): Promise<void> {
  return new Promise((resolve) => {
    let count = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "completed" && ++count >= n) {
        unsubscribe();
        resolve();
      }
    });
  });
}

export function record(session: AgentSession): AgentRuntimeEvent[] {
  const events: AgentRuntimeEvent[] = [];
  session.subscribe((event) => events.push(event));
  return events;
}

/** Sends `text` as one turn and returns every event the session emitted until it completed. */
export async function runTurn(session: AgentSession, text: string): Promise<AgentRuntimeEvent[]> {
  const events = record(session);
  const completed = nthCompleted(session, 1);
  await session.sendMessage(text);
  await completed;
  return events;
}

type SessionReport = { sessionId: string; replacedSessionId?: string };

/** Runs `body` against a session in a fresh temporary workspace whose launches are logged. */
export async function withSession(
  options: {
    environment?: Record<string, string>;
    sessionId?: string;
    runtime?: AgentSessionOptions["runtime"];
  },
  body: (
    session: AgentSession,
    launches: () => Promise<Launch[]>,
    reports: SessionReport[],
    directory: string,
  ) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "antigravity-"));
  const log = join(directory, "launches.jsonl");
  const reports: SessionReport[] = [];
  try {
    const session = await antigravityProvider({
      command: [process.execPath, FIXTURE],
    }).createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: INSTRUCTIONS,
      sessionId: options.sessionId,
      runtime: options.runtime,
      onSessionId: async (sessionId, replacedSessionId) => {
        reports.push(replacedSessionId ? { sessionId, replacedSessionId } : { sessionId });
      },
      environment: {
        COFORGE_AGY_MODE: "text",
        COFORGE_AGY_LAUNCH_LOG: log,
        ...options.environment,
      },
    });
    try {
      await body(session, () => readLaunches(log), reports, directory);
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
