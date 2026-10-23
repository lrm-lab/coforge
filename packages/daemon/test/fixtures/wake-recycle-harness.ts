import { afterAll, afterEach, beforeEach, setSystemTime } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogRecord } from "@logtape/logtape";
import type {
  AgentActivity,
  AgentSessionReport,
  AgentStartIntent,
} from "@lrm/coforge-sdk/internal";
import type {
  AgentRuntimeConfig,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionOptions,
  CodeAgentProvider,
  SessionResumeFacts,
} from "#src/code-agent/contract";
import { agentWorkspaceDirectory } from "#src/agent-runtime/agent-workspace-path";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime, type WorkspaceConfig } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./code-agent-discovery";
import { captureDaemonLogs } from "../log-capture";

export const connection: WorkspaceConfig = {
  computerId: "computer-a",
  workspaceId: "workspace-a",
  workspaceRoot: join(realpathSync(tmpdir()), `coforge-wake-recycle-${crypto.randomUUID()}`),
};
export const config: AgentRuntimeConfig = {
  provider: "claude-code",
  model: "default",
  modelProvider: "anthropic",
  reasoning: "balanced",
};
export const START = new Date("2026-10-23T00:00:00.000Z");
export const minutes = (count: number) => new Date(START.getTime() + count * 60_000);
export const COLD: SessionResumeFacts = {
  lastActivityAtMs: START.getTime(),
  lastContextTokens: 300_000,
};
export const MEMORY = "# Memory\n- [notes](notes/a.md)\n";
export const PROVIDER_BRIEFING = "<recent-actions>edited runtime.ts</recent-actions>";

export const SWEEP_MS = "COFORGE_WAKE_RECYCLE_SWEEP_MS";
const ENV_KEYS = [SWEEP_MS, "COFORGE_WAKE_RECYCLE"];

/** Registers the environment and clock isolation every wake-recycle runtime test needs. */
export function useWakeRecycleEnvironment() {
  const savedEnv = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv.set(key, Bun.env[key]);
      delete Bun.env[key];
    }
  });
  afterEach(() => {
    setSystemTime();
    for (const [key, value] of savedEnv)
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
  });
  afterAll(() => rm(connection.workspaceRoot, { recursive: true, force: true }));
}

export type HarnessOptions = {
  seam?: boolean;
  facts?: SessionResumeFacts | undefined;
  briefing?: "fails" | "none";
  launchEnvVars?: Record<string, string>;
  /** `false`: no MEMORY.md; `"long"`: one past the briefing's budget. */
  memory?: boolean | "long";
  /** Holds the first session's `dispose` open until it settles. */
  disposeGate?: Promise<void>;
  /** The first session's `dispose` fails, as a process that will not exit does. */
  disposeFails?: boolean;
  /** The first attempt to create a session fails, as a spawn failure does. */
  failFirstCreate?: boolean;
};

/** One Claude-like Agent whose sessions, session reads and briefings can be observed. */
export async function harness(options: HarnessOptions = {}) {
  setSystemTime(START);
  const credentials = new InMemoryDaemonCredentialStore();
  await credentials.save(connection.workspaceId, connection.computerId, "token-a");
  const agentDirectory = agentWorkspaceDirectory(
    connection.workspaceRoot,
    connection.workspaceId,
    "agent-a",
  );
  await mkdir(agentDirectory, { recursive: true });
  const memoryFile = join(agentDirectory, "MEMORY.md");
  if (options.memory === false) await rm(memoryFile, { force: true });
  else
    await writeFile(
      memoryFile,
      options.memory === "long" ? `${MEMORY}${"- entry\n".repeat(5_000)}` : MEMORY,
    );
  const sessions: Array<{
    options: AgentSessionOptions;
    inputs: string[];
    disposed: boolean;
    disposeFailed: boolean;
    emit(event: AgentRuntimeEvent): void;
    /** Ends the turn the session's last notice started. */
    finish(): void;
  }> = [];
  const activities: AgentActivity[] = [];
  const reports: AgentSessionReport[] = [];
  const statuses: string[] = [];
  const rejections: string[] = [];
  const acks: string[] = [];
  const factReads: Array<{ sessionId: string; envVars?: Readonly<Record<string, string>> }> = [];
  let createFailed = false;
  const activityWaiters: Array<{ matches(a: AgentActivity): boolean; done(): void }> = [];
  const factsOf = "facts" in options ? options.facts : COLD;
  const provider: CodeAgentProvider = {
    provider: "claude-code",
    async createAgentSession(sessionOptions: AgentSessionOptions) {
      if (options.failFirstCreate && !createFailed) {
        createFailed = true;
        throw new Error("spawn failed");
      }
      const listeners = new Set<(event: AgentRuntimeEvent) => void>();
      const exitListeners = new Set<() => void>();
      const emit = (event: AgentRuntimeEvent) => {
        for (const listener of listeners) listener(event);
      };
      let liveTurn = false;
      const record = {
        options: sessionOptions,
        inputs: [] as string[],
        disposed: false,
        disposeFailed: false,
        emit,
        finish() {
          liveTurn = false;
          emit({ type: "completed", status: "completed" });
        },
      };
      sessions.push(record);
      await sessionOptions.onSessionId?.(`native-${sessions.length}`);
      return {
        async sendMessage(text: string) {
          record.inputs.push(text);
          emit({ type: "completed", status: "completed" });
        },
        async notify(text: string) {
          record.inputs.push(text);
          liveTurn = true;
        },
        get hasLiveTurn() {
          return liveTurn;
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async interrupt() {},
        onExit(listener) {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
        async dispose() {
          if (sessions[0] === record) await options.disposeGate;
          // Only the first attempt fails; the runtime's own shutdown must still be able to end it.
          if (sessions[0] === record && options.disposeFails && !record.disposeFailed) {
            record.disposeFailed = true;
            throw new Error("would not exit");
          }
          record.disposed = true;
          for (const listener of Array.from(exitListeners)) listener();
        },
      } satisfies AgentSession;
    },
    ...(options.seam === false
      ? {}
      : {
          async readSessionResumeFacts(read) {
            factReads.push(read);
            return factsOf;
          },
          async readRecycleBriefing() {
            if (options.briefing === "fails") throw new Error("transcript unreadable");
            return options.briefing === "none" ? undefined : PROVIDER_BRIEFING;
          },
        }),
  };
  const runtime = new DaemonRuntime(
    connection,
    () => provider,
    credentials,
    {
      create: () => ({
        async start() {},
        async ready() {},
        async stop() {},
        async requestAgentLaunchConfig() {
          return {
            agentApiKey: `sk_agent_${"a".repeat(43)}`,
            ...(options.launchEnvVars ? { envVars: options.launchEnvVars } : {}),
          };
        },
        async revokeAgentApiKey() {},
        sendAgentActivity(activity) {
          activities.push(activity);
          for (const waiter of activityWaiters) if (waiter.matches(activity)) waiter.done();
        },
        sendAgentStatus(status) {
          statuses.push(status.status);
        },
        async sendAgentControlResult() {},
        async reportAgentSession(report) {
          reports.push(report);
        },
        async sendAgentDeliveryAck(ack) {
          acks.push(ack.deliveryId);
        },
        async sendAgentDeliveryRejection(rejection) {
          rejections.push(rejection.deliveryId);
        },
      }),
    },
    undefined,
    emptyCodeAgentDiscovery,
    // App Inbox and conversation state land under the Workspace root, which the suite removes;
    // each harness gets its own, so a message one test delivered is not already read in the next.
    join(connection.workspaceRoot, `state-${crypto.randomUUID()}`),
  );
  await runtime.start(connection);
  const intent = (overrides: Partial<AgentStartIntent> = {}): AgentStartIntent => ({
    protocolMajor: 1,
    requestId: "start-1",
    workspaceId: connection.workspaceId,
    computerId: connection.computerId,
    agentId: "agent-a",
    ...config,
    ...overrides,
  });
  return {
    runtime,
    sessions,
    activities,
    reports,
    statuses,
    rejections,
    acks,
    factReads,
    intent,
    /** Resolves when an Activity with this detail has been sent (now or later). */
    activityWith(detail: RegExp) {
      const matches = (a: AgentActivity) => detail.test(a.detail);
      if (activities.some(matches)) return Promise.resolve();
      const arrived = Promise.withResolvers<void>();
      activityWaiters.push({ matches, done: arrived.resolve });
      return arrived.promise;
    },
    details: (kind: string) => activities.filter((a) => a.detailKind === kind).map((a) => a.detail),
    deliver: (sequence: number) =>
      runtime.handleAgentMessage({
        protocolMajor: 1,
        requestId: `request-${sequence}`,
        messageId: `message-${sequence}`,
        deliveryId: `delivery-${sequence}`,
        sequence,
        workspaceId: connection.workspaceId,
        conversationId: "conversation-a",
        agentId: "agent-a",
        body: `body-${sequence}`,
        method: "agent:v1:message:deliver",
        target: "#general",
        mentionsAgent: true,
      }),
  };
}

/** Runs `body` with a harness started inside the log capture, so the sweep's timer logs into it. */
export function run<T>(
  options: HarnessOptions,
  body: (h: Awaited<ReturnType<typeof harness>>, records: readonly LogRecord[]) => Promise<T>,
) {
  return captureDaemonLogs(async (records) => {
    const h = await harness(options);
    try {
      return await body(h, records);
    } finally {
      await h.runtime.stop();
    }
  });
}

/** Waits for a log record, which is how a timer-driven sweep makes its completion observable. */
export async function logged(records: readonly LogRecord[], match: (r: LogRecord) => boolean) {
  while (!records.some(match)) await Bun.sleep(1);
  return records.find(match)!;
}
export const sweepWith = (stops: number) => (r: LogRecord) =>
  r.properties.event === "agent.runtime.cold_idle_sweep" && r.properties.stops === stops;

export const FRESH_ACTIVITY =
  "Starting a fresh Claude Code session (idle 90m, ~300k context) with a briefing";

export type Harness = Awaited<ReturnType<typeof harness>>;

/** Waits for state a background launch reaches; the test's own timeout bounds it. */
export async function until(condition: () => boolean) {
  while (!condition()) await Bun.sleep(1);
}
