import type { AgentRuntimeEvent, AgentSessionOptions } from "@coforge/agent";
import type { AcpConnection } from "#src/acp/connection";
import type { AcpSessionProfile, AcpSessionSink, AcpTurnReader } from "#src/acp/profile";
import { AcpSession } from "#src/acp/session";

export type PendingRequest = {
  method: string;
  params: unknown;
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

const SIMPLE_TURN: AcpTurnReader = {
  read: (update) =>
    update.sessionUpdate === "text" ? [{ type: "text-delta", text: String(update.text) }] : [],
  end: () => [],
};

export async function openTestAcpSession(profilePatch: Partial<AcpSessionProfile> = {}) {
  const requests: PendingRequest[] = [];
  const waiters: { method: string; deliver(entry: PendingRequest): void }[] = [];
  const delivered = new Set<PendingRequest>();
  const nextRequest = (method: string) => {
    const existing = requests.find((entry) => entry.method === method && !delivered.has(entry));
    if (existing) {
      delivered.add(existing);
      return Promise.resolve(existing);
    }
    return new Promise<PendingRequest>((resolve) =>
      waiters.push({
        method,
        deliver: (entry) => {
          delivered.add(entry);
          resolve(entry);
        },
      }),
    );
  };
  let sink: AcpSessionSink | undefined;
  const connection = {
    process: { onFailure: () => () => {}, onClose: () => () => {} },
    initialize: async () => ({ protocolVersion: 1 }),
    dispose: async () => {},
    connection: {
      agent: {
        request: (method: string, params: unknown) =>
          new Promise((resolve, reject) => {
            const entry = { method, params, resolve, reject };
            requests.push(entry);
            const index = waiters.findIndex((waiter) => waiter.method === method);
            if (index >= 0) waiters.splice(index, 1)[0]!.deliver(entry);
          }),
        notify: async () => {},
      },
    },
  } as unknown as AcpConnection;
  const events: AgentRuntimeEvent[] = [];
  const session = new AcpSession(
    {
      label: "Test",
      openTransport: (value) => {
        sink = value;
        return connection;
      },
      openSession: async () => ({ sessionId: "s1", resumable: true }),
      turn: () => SIMPLE_TURN,
      ...profilePatch,
    },
    { agentWorkspaceDirectory: "/tmp", instructions: "" } satisfies AgentSessionOptions,
    1_000,
    (work) => work,
  );
  session.subscribe((event) => events.push(event));
  await session.open();
  return {
    session,
    events,
    nextRequest,
    update: (update: Record<string, unknown>) => sink!.update("s1", update),
    notification: (method: string, params: Record<string, unknown>) =>
      sink!.notification(method, params),
    promptWritten: () => sink!.promptWritten(),
  };
}
