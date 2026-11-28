import { describe, expect, test } from "bun:test";
import {
  decodeTerminalControl,
  decodeTerminalFrame,
  TERMINAL_MAX_CHUNK_BYTES,
  type ComputerTerminalControl,
  type ComputerTerminalFrame,
} from "@lrm/coforge-sdk/internal/computer-terminal-wire";

import { terminalAttachChannel } from "#src/features/computers/terminal/computer-terminal-channel";
import { InMemoryComputerTerminalStore } from "#src/server/computers/computer-terminal-store.server";
import {
  ComputerTerminalService,
  type ComputerTerminalRepository,
  type TerminalComputerRecord,
  type TerminalViewer,
} from "#src/server/computers/computer-terminal.server";
import {
  revokeComputerTerminalScope,
  revokeComputerTerminalWhenDaemonReplaced,
  revokeUserTerminalSessionAttachments,
} from "#src/server/computers/computer-terminal-revocation.server";

const WORKSPACE_ID = "00000000-0000-5000-8000-000000000001";
const COMPUTER_ID = "00000000-0000-5000-8000-000000000002";
const COMPUTER_ID_2 = "00000000-0000-5000-8000-000000000003";
const OWNER_ID = "00000000-0000-5000-8000-000000000010";
const MEMBER_ID = "00000000-0000-5000-8000-000000000011";

function createHarness(initial?: Partial<TerminalComputerRecord>) {
  const computers = new Map<string, TerminalComputerRecord>([
    [
      `${WORKSPACE_ID}:${COMPUTER_ID}`,
      {
        computerId: COMPUTER_ID,
        ownerId: OWNER_ID,
        isMember: true,
        platform: "darwin",
        terminalEnabled: true,
        ownerWebLoginGeneration: 1,
        ...initial,
      },
    ],
  ]);

  let nowMs = 1_700_000_000_000;
  let online = true;
  let supported = true;
  let workerInstanceId: string | undefined = "daemon-1";
  let tokenCounter = 0;

  const store = new InMemoryComputerTerminalStore(() => nowMs);
  const publishedControls: {
    workspaceId: string;
    computerId: string;
    control: ComputerTerminalControl;
  }[] = [];
  const publishedFrames: { channel: string; frame: ComputerTerminalFrame }[] = [];
  const unsubscribed: { user: string; channel: string }[][] = [];

  const repository: ComputerTerminalRepository = {
    async findComputer({ workspaceId, computerId, userId }) {
      const record = computers.get(`${workspaceId}:${computerId}`);
      if (!record) return undefined;
      return {
        ...record,
        isMember: userId === OWNER_ID || userId === MEMBER_ID ? record.isMember : false,
      };
    },
    async setTerminalEnabled({ workspaceId, computerId }, enabled) {
      const record = computers.get(`${workspaceId}:${computerId}`);
      if (!record) throw new Error("not found");
      record.terminalEnabled = enabled;
    },
  };

  const service = new ComputerTerminalService({
    repository,
    store,
    online: async () => online,
    supportsCapability: async (_scope, workerId) => supported && workerId === workerInstanceId,
    daemonIdentity: async () => (workerInstanceId ? { workerInstanceId } : undefined),
    publishControl: async (workspaceId, computerId, bytes) => {
      publishedControls.push({
        workspaceId,
        computerId,
        control: decodeTerminalControl(bytes),
      });
    },
    publishFrame: async (channel, bytes) => {
      publishedFrames.push({ channel, frame: decodeTerminalFrame(bytes) });
    },
    unsubscribeUserChannel: async (subscriptions) => {
      if (subscriptions.length > 0) unsubscribed.push([...subscriptions]);
    },
    issueSubscriptionToken: async ({ userId, attachId }) => {
      tokenCounter += 1;
      return {
        token: `tok-${tokenCounter}-${userId}-${attachId}`,
        channel: terminalAttachChannel(attachId),
        expiresAtMs: nowMs + 60_000,
      };
    },
    now: () => nowMs,
  });

  const ownerViewer: TerminalViewer = {
    userId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    loginGeneration: 1,
  };
  const memberViewer: TerminalViewer = {
    userId: MEMBER_ID,
    workspaceId: WORKSPACE_ID,
    loginGeneration: 1,
  };

  return {
    computers,
    store,
    service,
    ownerViewer,
    memberViewer,
    publishedControls,
    publishedFrames,
    unsubscribed,
    setOnline: (value: boolean) => {
      online = value;
    },
    setSupported: (value: boolean) => {
      supported = value;
    },
    setWorkerInstanceId: (value: string | undefined) => {
      workerInstanceId = value;
    },
    bumpLoginGeneration: (next: number) => {
      for (const record of computers.values()) record.ownerWebLoginGeneration = next;
    },
    revocationPorts: () => ({
      store,
      publishControl: async (workspaceId: string, computerId: string, bytes: Uint8Array) => {
        publishedControls.push({
          workspaceId,
          computerId,
          control: decodeTerminalControl(bytes),
        });
      },
      publishFrame: async (channel: string, bytes: Uint8Array) => {
        publishedFrames.push({ channel, frame: decodeTerminalFrame(bytes) });
      },
      unsubscribeUserChannel: async (subs: readonly { user: string; channel: string }[]) => {
        if (subs.length > 0) unsubscribed.push([...subs]);
      },
    }),
  };
}

const DEFAULT_ATTACH = {
  computerId: COMPUTER_ID,
  cols: 80,
  rows: 24,
  takeover: false,
  mode: "interactive" as const,
};

function scopeOf(prepared: {
  scope: { sessionId: string; attachId: string; attachGeneration: number };
}) {
  return {
    computerId: COMPUTER_ID,
    sessionId: prepared.scope.sessionId,
    attachId: prepared.scope.attachId,
    attachGeneration: prepared.scope.attachGeneration,
  };
}

describe("ComputerTerminalService", () => {
  test("denies non-owners across status, toggle, attach, input, resize, detach, and close", async () => {
    const h = createHarness();
    expect(await h.service.readStatus(h.memberViewer, COMPUTER_ID)).toEqual({ unauthorized: true });
    await expect(h.service.setEnabled(h.memberViewer, COMPUTER_ID, true)).rejects.toThrow();
    await expect(h.service.prepareAttach(h.memberViewer, DEFAULT_ATTACH)).rejects.toThrow();

    const prepared = await h.service.prepareAttach(h.ownerViewer, DEFAULT_ATTACH);
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") throw new Error("expected prepared");

    const attachRef = scopeOf(prepared);
    await expect(
      h.service.activateAttach(h.memberViewer, {
        ...attachRef,
        cols: 80,
        rows: 24,
        takeover: false,
      }),
    ).rejects.toThrow();
    await expect(h.service.refreshSubscription(h.memberViewer, attachRef)).rejects.toThrow();
    await expect(
      h.service.sendInput(h.memberViewer, {
        ...attachRef,
        inputSeq: 1,
        bytes: new TextEncoder().encode("ls\n"),
      }),
    ).rejects.toThrow();
    await expect(
      h.service.resize(h.memberViewer, { ...attachRef, cols: 100, rows: 30 }),
    ).rejects.toThrow();
    await expect(h.service.detach(h.memberViewer, attachRef)).rejects.toThrow();
    await expect(h.service.close(h.memberViewer, attachRef)).rejects.toThrow();
  });

  test("gates on terminalEnabled and revokes active and detached sessions when disabled", async () => {
    const h = createHarness({ terminalEnabled: false });
    expect(await h.service.readStatus(h.ownerViewer, COMPUTER_ID)).toEqual({
      enabled: false,
      status: "ready",
      hasActiveSession: false,
      hasActiveAttach: false,
      platform: "darwin",
    });
    await expect(h.service.prepareAttach(h.ownerViewer, DEFAULT_ATTACH)).rejects.toThrow();

    await h.service.setEnabled(h.ownerViewer, COMPUTER_ID, true);
    const prepared = await h.service.prepareAttach(h.ownerViewer, DEFAULT_ATTACH);
    if (prepared.status !== "prepared") throw new Error("expected prepared");

    await h.service.setEnabled(h.ownerViewer, COMPUTER_ID, false);
    expect(h.unsubscribed.at(-1)).toEqual([
      { user: OWNER_ID, channel: terminalAttachChannel(prepared.scope.attachId) },
    ]);
    expect(h.publishedControls.at(-1)?.control.command).toEqual({ case: "close", value: {} });
    expect(
      await h.store.getSession({ workspaceId: WORKSPACE_ID, computerId: COMPUTER_ID }),
    ).toBeUndefined();

    await h.service.setEnabled(h.ownerViewer, COMPUTER_ID, true);
    const second = await h.service.prepareAttach(h.ownerViewer, DEFAULT_ATTACH);
    if (second.status !== "prepared") throw new Error("expected prepared");
    await h.service.detach(h.ownerViewer, scopeOf(second));
    const controlsBeforeDisable = h.publishedControls.length;
    await h.service.setEnabled(h.ownerViewer, COMPUTER_ID, false);
    const emittedOnDisable = h.publishedControls.slice(controlsBeforeDisable);
    expect(emittedOnDisable.map((entry) => entry.control.command.case)).toEqual([
      "openOrAttach",
      "close",
    ]);
    expect(
      await h.store.getSession({ workspaceId: WORKSPACE_ID, computerId: COMPUTER_ID }),
    ).toBeUndefined();
  });

  test("reports unsupported, disconnected, and needs_upgrade states accurately", async () => {
    const h = createHarness({ platform: "win32" });
    expect(await h.service.readStatus(h.ownerViewer, COMPUTER_ID)).toMatchObject({
      status: "unsupported",
    });

    h.computers.get(`${WORKSPACE_ID}:${COMPUTER_ID}`)!.platform = "linux";
    h.setSupported(false);
    expect(await h.service.readStatus(h.ownerViewer, COMPUTER_ID)).toMatchObject({
      status: "needs_upgrade",
    });

    h.setOnline(false);
    expect(await h.service.readStatus(h.ownerViewer, COMPUTER_ID)).toMatchObject({
      status: "disconnected",
    });

    h.setOnline(true);
    h.setSupported(true);
    expect(await h.service.readStatus(h.ownerViewer, COMPUTER_ID)).toMatchObject({
      status: "ready",
    });
  });

  test("reuses one session across detach, fences attach conflicts, and revokes old attach on takeover", async () => {
    const h = createHarness();
    const first = await h.service.prepareAttach(h.ownerViewer, {
      computerId: COMPUTER_ID,
      cols: 90,
      rows: 30,
      takeover: false,
      mode: "interactive",
    });
    if (first.status !== "prepared") throw new Error("expected first attach");

    const conflict = await h.service.prepareAttach(h.ownerViewer, {
      computerId: COMPUTER_ID,
      cols: 90,
      rows: 30,
      takeover: false,
      mode: "interactive",
    });
    expect(conflict).toEqual({ status: "attach_conflict" });

    const takeover = await h.service.prepareAttach(h.ownerViewer, {
      computerId: COMPUTER_ID,
      cols: 100,
      rows: 32,
      takeover: true,
      mode: "interactive",
    });
    if (takeover.status !== "prepared") throw new Error("expected takeover attach");
    expect(takeover.scope.sessionId).toBe(first.scope.sessionId);
    expect(takeover.scope.attachGeneration).toBe(2);
    expect(takeover.scope.attachId).not.toBe(first.scope.attachId);
    expect(h.unsubscribed).toEqual([
      [{ user: OWNER_ID, channel: terminalAttachChannel(first.scope.attachId) }],
    ]);

    await h.service.detach(h.ownerViewer, {
      computerId: COMPUTER_ID,
      sessionId: takeover.scope.sessionId,
      attachId: takeover.scope.attachId,
      attachGeneration: takeover.scope.attachGeneration,
    });

    const reattached = await h.service.prepareAttach(h.ownerViewer, {
      computerId: COMPUTER_ID,
      cols: 100,
      rows: 32,
      takeover: false,
      mode: "interactive",
    });
    if (reattached.status !== "prepared") throw new Error("expected reattach");
    expect(reattached.scope.sessionId).toBe(first.scope.sessionId);
    expect(reattached.scope.attachGeneration).toBe(3);
  });

  test("enforces monotonic input sequencing with dedup and gap reporting", async () => {
    const h = createHarness();
    const prepared = await h.service.prepareAttach(h.ownerViewer, DEFAULT_ATTACH);
    if (prepared.status !== "prepared") throw new Error("expected prepared");
    const ref = scopeOf(prepared);

    const bytes = new TextEncoder().encode("pwd\n");
    expect(await h.service.sendInput(h.ownerViewer, { ...ref, inputSeq: 1, bytes })).toEqual({
      status: "accepted",
      nextInputSeq: 2,
    });
    expect(await h.service.sendInput(h.ownerViewer, { ...ref, inputSeq: 1, bytes })).toEqual({
      status: "duplicate",
      nextInputSeq: 2,
    });
    expect(await h.service.sendInput(h.ownerViewer, { ...ref, inputSeq: 4, bytes })).toEqual({
      status: "sequence_mismatch",
      expectedInputSeq: 2,
    });
    expect(h.publishedControls).toHaveLength(1);
    expect(await h.service.sendInput(h.ownerViewer, { ...ref, inputSeq: 2, bytes })).toEqual({
      status: "accepted",
      nextInputSeq: 3,
    });
    expect(h.publishedControls).toHaveLength(2);

    await expect(
      h.service.sendInput(h.ownerViewer, {
        ...ref,
        inputSeq: 3,
        bytes: new Uint8Array(TERMINAL_MAX_CHUNK_BYTES + 1),
      }),
    ).rejects.toThrow();
  });

  test("forbids input and resize on readonly attach while allowing explicit close", async () => {
    const h = createHarness();
    const prepared = await h.service.prepareAttach(h.ownerViewer, {
      computerId: COMPUTER_ID,
      cols: 80,
      rows: 24,
      takeover: false,
      mode: "readonly",
    });
    if (prepared.status !== "prepared") throw new Error("expected prepared");
    const ref = {
      computerId: COMPUTER_ID,
      sessionId: prepared.scope.sessionId,
      attachId: prepared.scope.attachId,
      attachGeneration: prepared.scope.attachGeneration,
    };

    await h.service.activateAttach(h.ownerViewer, {
      ...ref,
      cols: 80,
      rows: 24,
      takeover: false,
    });
    await expect(
      h.service.sendInput(h.ownerViewer, {
        ...ref,
        inputSeq: 1,
        bytes: new TextEncoder().encode("ls\n"),
      }),
    ).rejects.toThrow();
    await expect(h.service.resize(h.ownerViewer, { ...ref, cols: 90, rows: 30 })).rejects.toThrow();

    await h.service.close(h.ownerViewer, ref);
    expect(h.publishedControls.at(-1)?.control.command).toEqual({ case: "close", value: {} });
  });

  test("preserves existing session dimensions when readonly reattaches", async () => {
    const h = createHarness();
    const interactive = await h.service.prepareAttach(h.ownerViewer, {
      computerId: COMPUTER_ID,
      cols: 120,
      rows: 40,
      takeover: false,
      mode: "interactive",
    });
    if (interactive.status !== "prepared") throw new Error("expected prepared");
    await h.service.resize(h.ownerViewer, {
      computerId: COMPUTER_ID,
      sessionId: interactive.scope.sessionId,
      attachId: interactive.scope.attachId,
      attachGeneration: interactive.scope.attachGeneration,
      cols: 132,
      rows: 42,
    });
    await h.service.detach(h.ownerViewer, {
      computerId: COMPUTER_ID,
      sessionId: interactive.scope.sessionId,
      attachId: interactive.scope.attachId,
      attachGeneration: interactive.scope.attachGeneration,
    });
    const readonlyAttach = await h.service.prepareAttach(h.ownerViewer, {
      computerId: COMPUTER_ID,
      cols: 40,
      rows: 20,
      takeover: false,
      mode: "readonly",
    });
    if (readonlyAttach.status !== "prepared") throw new Error("expected readonly attach");
    expect({ cols: readonlyAttach.cols, rows: readonlyAttach.rows }).toEqual({
      cols: 132,
      rows: 42,
    });
    await h.service.activateAttach(h.ownerViewer, {
      computerId: COMPUTER_ID,
      sessionId: readonlyAttach.scope.sessionId,
      attachId: readonlyAttach.scope.attachId,
      attachGeneration: readonlyAttach.scope.attachGeneration,
      cols: 40,
      rows: 20,
      takeover: false,
    });
    expect(h.publishedControls.at(-1)?.control.command).toEqual({
      case: "openOrAttach",
      value: { cols: 132, rows: 42, takeover: false },
    });
  });

  test("revokes access when web login generation advances or logout revokes attachments", async () => {
    const h = createHarness();
    h.computers.set(`${WORKSPACE_ID}:${COMPUTER_ID_2}`, {
      computerId: COMPUTER_ID_2,
      ownerId: OWNER_ID,
      isMember: true,
      platform: "linux",
      terminalEnabled: true,
      ownerWebLoginGeneration: 1,
    });

    const first = await h.service.prepareAttach(h.ownerViewer, DEFAULT_ATTACH);
    const second = await h.service.prepareAttach(h.ownerViewer, {
      ...DEFAULT_ATTACH,
      computerId: COMPUTER_ID_2,
    });
    if (first.status !== "prepared" || second.status !== "prepared")
      throw new Error("expected prepared");

    h.bumpLoginGeneration(2);
    expect(await h.service.readStatus(h.ownerViewer, COMPUTER_ID)).toEqual({ unauthorized: true });
    await expect(h.service.refreshSubscription(h.ownerViewer, scopeOf(first))).rejects.toThrow();
    await expect(
      h.service.sendInput(h.ownerViewer, {
        ...scopeOf(first),
        inputSeq: 1,
        bytes: new TextEncoder().encode("id\n"),
      }),
    ).rejects.toThrow();

    await revokeUserTerminalSessionAttachments(h.revocationPorts(), OWNER_ID);

    expect(h.unsubscribed.at(-1)).toEqual([
      { user: OWNER_ID, channel: terminalAttachChannel(first.scope.attachId) },
      { user: OWNER_ID, channel: terminalAttachChannel(second.scope.attachId) },
    ]);
    expect(h.publishedControls.map((entry) => entry.control.command.case)).toEqual([
      "detach",
      "detach",
    ]);
  });

  test("revokes on computer unlink and daemon instance replacement", async () => {
    const h = createHarness();
    const first = await h.service.prepareAttach(h.ownerViewer, DEFAULT_ATTACH);
    if (first.status !== "prepared") throw new Error("expected prepared");

    const ports = h.revocationPorts();

    await revokeComputerTerminalWhenDaemonReplaced(
      ports,
      { workspaceId: WORKSPACE_ID, computerId: COMPUTER_ID },
      "daemon-1",
    );
    expect(h.publishedFrames).toHaveLength(0);

    await revokeComputerTerminalWhenDaemonReplaced(
      ports,
      { workspaceId: WORKSPACE_ID, computerId: COMPUTER_ID },
      "daemon-2",
    );
    expect(h.publishedFrames).toHaveLength(1);
    expect(h.publishedFrames[0]?.frame.event).toEqual({
      case: "closed",
      value: { reason: "daemon_replaced" },
    });
    expect(h.unsubscribed.at(-1)).toEqual([
      { user: OWNER_ID, channel: terminalAttachChannel(first.scope.attachId) },
    ]);

    h.setWorkerInstanceId("daemon-2");
    const next = await h.service.prepareAttach(h.ownerViewer, DEFAULT_ATTACH);
    if (next.status !== "prepared") throw new Error("expected prepared");
    expect(next.scope.sessionId).not.toBe(first.scope.sessionId);

    await revokeComputerTerminalScope(ports, {
      workspaceId: WORKSPACE_ID,
      computerId: COMPUTER_ID,
      closeShell: true,
    });
    expect(h.publishedControls.at(-1)?.control.command).toEqual({ case: "close", value: {} });
    expect(
      await h.store.getSession({ workspaceId: WORKSPACE_ID, computerId: COMPUTER_ID }),
    ).toBeUndefined();
  });
});
