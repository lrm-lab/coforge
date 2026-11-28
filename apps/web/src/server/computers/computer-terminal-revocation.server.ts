import {
  encodeTerminalControl,
  encodeTerminalFrame,
  type TerminalScope,
} from "@lrm/coforge-sdk/internal/computer-terminal-wire";

import { terminalAttachChannel } from "#src/features/computers/terminal/computer-terminal-channel";
import { daemonControlChannel } from "#src/server/centrifugo/server-api.server";
import type {
  ComputerTerminalStore,
  TerminalScopeKey,
  TerminalSessionRecord,
} from "./computer-terminal-store.server";

export type TerminalRevocationPorts = {
  store: ComputerTerminalStore;
  publishControl(workspaceId: string, computerId: string, bytes: Uint8Array): Promise<void>;
  publishFrame(channel: string, bytes: Uint8Array): Promise<void>;
  unsubscribeUserChannel(
    subscriptions: readonly { user: string; channel: string }[],
  ): Promise<void>;
};

export function makeTerminalScope(
  session: Pick<TerminalSessionRecord, "workspaceId" | "computerId" | "ownerUserId" | "sessionId">,
  attachId: string,
  attachGeneration: number,
): TerminalScope {
  return {
    protocolMajor: 1,
    workspaceId: session.workspaceId,
    computerId: session.computerId,
    ownerUserId: session.ownerUserId,
    sessionId: session.sessionId,
    attachId,
    attachGeneration,
  };
}

export function createCentrifugoTerminalControlPublisher(
  publish: (
    channel: string,
    bytes: Uint8Array,
    options?: { skipHistory?: boolean },
  ) => Promise<void>,
) {
  return (workspaceId: string, computerId: string, bytes: Uint8Array) =>
    publish(daemonControlChannel(workspaceId, computerId), bytes, { skipHistory: true });
}

export async function unsubscribeTerminalAttach(
  ports: Pick<TerminalRevocationPorts, "unsubscribeUserChannel">,
  session: TerminalSessionRecord,
): Promise<void> {
  if (!session.activeAttach) return;
  await ports
    .unsubscribeUserChannel([
      {
        user: session.ownerUserId,
        channel: terminalAttachChannel(session.activeAttach.attachId),
      },
    ])
    .catch(() => {});
}

export async function sendTerminalClose(
  ports: Pick<TerminalRevocationPorts, "publishControl">,
  cleared: TerminalSessionRecord,
): Promise<void> {
  const { workspaceId, computerId } = cleared;
  if (cleared.activeAttach) {
    await ports
      .publishControl(
        workspaceId,
        computerId,
        encodeTerminalControl({
          ...makeTerminalScope(
            cleared,
            cleared.activeAttach.attachId,
            cleared.activeAttach.attachGeneration,
          ),
          command: { case: "close", value: {} },
        }),
      )
      .catch(() => {});
    return;
  }
  const syntheticAttachId = `tc_${crypto.randomUUID().replaceAll("-", "")}`;
  const syntheticGeneration = cleared.attachGeneration + 1;
  const scope = makeTerminalScope(cleared, syntheticAttachId, syntheticGeneration);
  await ports
    .publishControl(
      workspaceId,
      computerId,
      encodeTerminalControl({
        ...scope,
        command: {
          case: "openOrAttach",
          value: { cols: cleared.cols, rows: cleared.rows, takeover: true },
        },
      }),
    )
    .catch(() => {});
  await ports
    .publishControl(
      workspaceId,
      computerId,
      encodeTerminalControl({
        ...scope,
        command: { case: "close", value: {} },
      }),
    )
    .catch(() => {});
}

export async function revokeComputerTerminalScope(
  ports: TerminalRevocationPorts,
  input: {
    workspaceId: string;
    computerId: string;
    closeShell: boolean;
    notifyReason?: "daemon_replaced" | "permission_denied";
  },
): Promise<void> {
  const scope = { workspaceId: input.workspaceId, computerId: input.computerId };
  const cleared = await ports.store.clearSession(scope);
  if (!cleared) return;
  if (cleared.activeAttach && input.notifyReason) {
    await ports
      .publishFrame(
        terminalAttachChannel(cleared.activeAttach.attachId),
        encodeTerminalFrame({
          ...makeTerminalScope(
            cleared,
            cleared.activeAttach.attachId,
            cleared.activeAttach.attachGeneration,
          ),
          event: { case: "closed", value: { reason: input.notifyReason } },
        }),
      )
      .catch(() => {});
  }
  await unsubscribeTerminalAttach(ports, cleared);
  if (input.closeShell) {
    await sendTerminalClose(ports, cleared);
  }
}

export async function revokeComputerTerminalWhenDaemonReplaced(
  ports: TerminalRevocationPorts,
  scope: TerminalScopeKey,
  newWorkerInstanceId: string,
): Promise<void> {
  const existing = await ports.store.getSession(scope);
  if (!existing || existing.daemonInstanceId === newWorkerInstanceId) return;
  await revokeComputerTerminalScope(ports, {
    ...scope,
    closeShell: false,
    notifyReason: "daemon_replaced",
  });
}

export async function revokeUserTerminalSessionAttachments(
  ports: TerminalRevocationPorts,
  userId: string,
): Promise<void> {
  const sessions = await ports.store.listUserAttachments(userId);
  if (sessions.length === 0) return;
  const subscriptions = sessions.flatMap((session) =>
    session.activeAttach
      ? [
          {
            user: session.ownerUserId,
            channel: terminalAttachChannel(session.activeAttach.attachId),
          },
        ]
      : [],
  );
  await ports.unsubscribeUserChannel(subscriptions).catch(() => {});
  await Promise.all(
    sessions.map(async (session) => {
      if (!session.activeAttach) return;
      const scope = { workspaceId: session.workspaceId, computerId: session.computerId };
      const expected = {
        sessionId: session.sessionId,
        attachId: session.activeAttach.attachId,
        attachGeneration: session.activeAttach.attachGeneration,
      };
      const detached = await ports.store.detachAttach(scope, expected).catch(() => undefined);
      if (!detached?.activeAttach) return;
      await ports
        .publishControl(
          scope.workspaceId,
          scope.computerId,
          encodeTerminalControl({
            ...makeTerminalScope(
              detached,
              detached.activeAttach.attachId,
              detached.activeAttach.attachGeneration,
            ),
            command: { case: "detach", value: {} },
          }),
        )
        .catch(() => {});
    }),
  );
}
