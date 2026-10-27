import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentSession } from "@lrm/coforge-anvil";
import { OpenCodeProvider } from "@lrm/coforge-anvil/opencode";
import { fixturePerTurnHost, fixtureVersionReader } from "./runtime-host";

export const OPENCODE_AGENT_FIXTURE = new URL("./opencode-fixture.ts", import.meta.url).pathname;
export const OPENCODE_INSTRUCTIONS = "Standing OpenCode instructions.";

export function openCodeProvider(): OpenCodeProvider {
  return new OpenCodeProvider({
    host: fixturePerTurnHost,
    versionReader: fixtureVersionReader,
    command: [process.execPath, OPENCODE_AGENT_FIXTURE],
  });
}

export type OpenCodeLaunch = {
  prompt: string;
  model?: string;
  variant?: string;
  resumeId?: string;
};

export async function readLaunches(log: string): Promise<OpenCodeLaunch[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** Resolves once `session` has emitted its Nth `completed` event. Registered before the input that
 * triggers it so no event can be missed to a race. */
export function nthCompleted(
  session: { subscribe(listener: (event: AgentRuntimeEvent) => void): () => void },
  n: number,
): Promise<void> {
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

/** Sends `text` and resolves once the turn it starts (or joins) has completed. */
export async function nthTurn(session: AgentSession, text: string): Promise<void> {
  const completed = nthCompleted(session, 1);
  await session.sendMessage(text);
  await completed;
}

/** Resolves once `session` has emitted its first `progress` event, the point at which a fake
 * opencode turn is running and (in `hang` mode) can answer an interrupt. */
export function firstProgress(session: AgentSession): Promise<void> {
  return new Promise((resolve) => {
    const off = session.subscribe((event) => {
      if (event.type === "progress") {
        off();
        resolve();
      }
    });
  });
}

export type SessionReport = { sessionId: string; replacedSessionId?: string };

/** Runs `body` against a session in a fresh temporary workspace whose launches are logged and
 * whose identity reports are collected. */
export async function withSession(
  options: { sessionId?: string; environment?: Record<string, string> },
  body: (harness: {
    session: AgentSession;
    launches: () => Promise<OpenCodeLaunch[]>;
    reports: SessionReport[];
    directory: string;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-session-"));
  const log = join(directory, "launches.jsonl");
  const reports: SessionReport[] = [];
  try {
    const session = await openCodeProvider().createAgentSession({
      agentWorkspaceDirectory: directory,
      instructions: OPENCODE_INSTRUCTIONS,
      sessionId: options.sessionId,
      onSessionId: async (sessionId, replacedSessionId) => {
        reports.push(replacedSessionId ? { sessionId, replacedSessionId } : { sessionId });
      },
      environment: {
        COFORGE_OPENCODE_MODE: "text",
        COFORGE_OPENCODE_LAUNCH_LOG: log,
        ...options.environment,
      },
    });
    try {
      await body({ session, launches: () => readLaunches(log), reports, directory });
    } finally {
      await session.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
