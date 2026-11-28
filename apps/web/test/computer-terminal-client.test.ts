import { describe, expect, test } from "bun:test";
import {
  encodeTerminalFrame,
  type ComputerTerminalFrame,
  type TerminalScope,
} from "@lrm/coforge-sdk/internal/computer-terminal-wire";

import {
  ComputerTerminalSessionController,
  type ComputerTerminalControllerState,
  type ComputerTerminalControllerTransport,
} from "#src/features/computers/terminal/computer-terminal-session-controller";
import {
  chunkTerminalInput,
  deriveStatusFromSnapshot,
  encodeBytesBase64,
  TerminalInputQueue,
} from "#src/features/computers/terminal/computer-terminal-state";
import type { TokenizedRealtimeOptions } from "#src/features/realtime/browser-realtime";
import type { PrepareTerminalAttachResult } from "#src/server/computers/computer-terminal.server";

const SCOPE: TerminalScope = {
  protocolMajor: 1,
  workspaceId: "00000000-0000-5000-8000-000000000001",
  computerId: "00000000-0000-5000-8000-000000000002",
  ownerUserId: "00000000-0000-5000-8000-000000000010",
  sessionId: "ts_1",
  attachId: "ta_1",
  attachGeneration: 1,
};

function makeFrameBytes(
  event: ComputerTerminalFrame["event"],
  overrides: Partial<TerminalScope> = {},
): Uint8Array {
  return encodeTerminalFrame({
    ...SCOPE,
    ...overrides,
    event,
  });
}

function createMockTransport() {
  const calls: string[] = [];
  const sentInputs: { inputSeq: number; dataBase64: string }[] = [];
  const resizes: { cols: number; rows: number }[] = [];
  let subscription: TokenizedRealtimeOptions | null = null;
  let unsubscribedCount = 0;
  let prepareResult: PrepareTerminalAttachResult = {
    status: "prepared",
    scope: SCOPE,
    channel: `terminal:${SCOPE.attachId}`,
    subscriptionToken: "tok-1",
    subscriptionExpiresAtMs: Date.now() + 60_000,
    daemonInstanceId: "daemon-1",
    mode: "interactive",
    cols: 80,
    rows: 24,
  };
  let statusResult: Awaited<ReturnType<ComputerTerminalControllerTransport["readStatus"]>> = {
    enabled: true,
    status: "ready",
    hasActiveSession: true,
    hasActiveAttach: false,
    platform: "darwin",
  };

  const transport: ComputerTerminalControllerTransport = {
    prepareAttach: async (input) => {
      calls.push(`prepare:${input.mode}:${input.takeover}`);
      return prepareResult.status === "prepared"
        ? { ...prepareResult, mode: input.mode, cols: input.cols, rows: input.rows }
        : prepareResult;
    },
    activateAttach: async () => {
      calls.push("activate");
      return { activated: true };
    },
    refreshSubscription: async () => ({
      token: "tok-refresh",
      channel: `terminal:${SCOPE.attachId}`,
      expiresAtMs: Date.now() + 60_000,
    }),
    sendInput: async (input) => {
      sentInputs.push({ inputSeq: input.inputSeq, dataBase64: input.dataBase64 });
      return { status: "accepted", nextInputSeq: input.inputSeq + 1 };
    },
    resize: async (input) => {
      resizes.push({ cols: input.cols, rows: input.rows });
      return { resized: true };
    },
    detach: async () => {
      calls.push("detach");
      return { detached: true };
    },
    close: async () => {
      calls.push("close");
      return { closed: true };
    },
    readStatus: async () => {
      calls.push("readStatus");
      return statusResult;
    },
    subscribeTokenized: (options) => {
      calls.push(`subscribe:${options.channel}`);
      subscription = options;
      return () => {
        unsubscribedCount += 1;
      };
    },
  };

  return {
    transport,
    calls,
    sentInputs,
    resizes,
    getSubscription: () => subscription,
    getUnsubscribedCount: () => unsubscribedCount,
    setPrepareResult: (next: PrepareTerminalAttachResult) => {
      prepareResult = next;
    },
    setStatusResult: (
      next: Awaited<ReturnType<ComputerTerminalControllerTransport["readStatus"]>>,
    ) => {
      statusResult = next;
    },
  };
}

describe("computer terminal state & input queue", () => {
  test("chunks multi-byte UTF-8 without splitting codepoints and roundtrips base64", () => {
    const sample = "你好世界😀abcdef";
    const chunks = chunkTerminalInput(sample, 6);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.byteLength).toBeLessThanOrEqual(6);
    }
    const decoded = chunks.map((chunk) => new TextDecoder("utf-8", { fatal: true }).decode(chunk));
    expect(decoded.join("")).toBe(sample);
    expect(atob(encodeBytesBase64(chunks[0]!)).length).toBe(chunks[0]!.byteLength);
  });

  test("maps status snapshots strictly to the six UI states", () => {
    expect(deriveStatusFromSnapshot({ unauthorized: true })).toBe("unauthorized");
    expect(
      deriveStatusFromSnapshot({
        enabled: false,
        status: "unsupported",
        hasActiveSession: false,
        hasActiveAttach: false,
        platform: "win32",
      }),
    ).toBe("unsupported");
    expect(
      deriveStatusFromSnapshot({
        enabled: true,
        status: "needs_upgrade",
        hasActiveSession: false,
        hasActiveAttach: false,
        platform: "darwin",
      }),
    ).toBe("needs_upgrade");
    expect(
      deriveStatusFromSnapshot({
        enabled: true,
        status: "ready",
        hasActiveSession: false,
        hasActiveAttach: false,
        platform: "darwin",
      }),
    ).toBe("disconnected");
  });

  test("serializes 1 in-flight input across HTTP + daemon inputAccepted and drops unconfirmed bytes on mismatch or reset", async () => {
    const sent: { seq: number; text: string }[] = [];
    let mismatchCount = 0;
    let resolveSecondHttp:
      | ((value: { status: "sequence_mismatch"; expectedInputSeq: number }) => void)
      | undefined;

    const queue = new TerminalInputQueue(
      {
        send: (seq, bytes) => {
          sent.push({ seq, text: new TextDecoder().decode(bytes) });
          if (seq === 1) {
            return Promise.resolve({ status: "accepted", nextInputSeq: 2 });
          }
          return new Promise((resolve) => {
            resolveSecondHttp = resolve;
          });
        },
        onSequenceMismatch: () => {
          mismatchCount += 1;
        },
      },
      32,
    );

    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("c");
    await Promise.resolve();
    expect(sent).toEqual([{ seq: 1, text: "a" }]);

    queue.acknowledge(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([
      { seq: 1, text: "a" },
      { seq: 2, text: "bc" },
    ]);

    queue.enqueue("unconfirmed");
    resolveSecondHttp?.({ status: "sequence_mismatch", expectedInputSeq: 5 });
    await Promise.resolve();
    await Promise.resolve();
    expect(mismatchCount).toBe(1);

    queue.reset();
    queue.enqueue("fresh");
    await Promise.resolve();
    expect(sent.at(-1)).toEqual({ seq: 1, text: "fresh" });
  });
});

describe("ComputerTerminalSessionController", () => {
  test("activates only after onSubscribed, replays snapshots in order, and blocks gaps", async () => {
    const mock = createMockTransport();
    const states: ComputerTerminalControllerState[] = [];
    const outputChunks: string[] = [];
    let resetCount = 0;

    const controller = new ComputerTerminalSessionController({
      computerId: SCOPE.computerId,
      transport: mock.transport,
      onStateChange: (next) => states.push(next),
      onOutput: (bytes) => outputChunks.push(new TextDecoder().decode(bytes)),
      onResetOutput: () => {
        resetCount += 1;
      },
    });

    await controller.connect({ cols: 100, rows: 30, takeover: false, mode: "interactive" });
    expect(mock.calls).toEqual([
      "prepare:interactive:false",
      `subscribe:terminal:${SCOPE.attachId}`,
    ]);

    const sub = mock.getSubscription()!;
    sub.onSubscribing?.();
    expect(mock.calls).not.toContain("activate");

    sub.onSubscribed?.();
    await Promise.resolve();
    expect(mock.calls).toContain("activate");

    sub.onPublication?.({
      channel: `terminal:${SCOPE.attachId}`,
      data: makeFrameBytes({
        case: "opened",
        value: {
          daemonInstanceId: "daemon-1",
          shellKind: "zsh",
          cols: 100,
          rows: 30,
          nextOutputSeq: 2,
          historyUnavailable: false,
        },
      }),
    });
    expect(resetCount).toBe(1);
    expect(states.at(-1)).toMatchObject({ status: "connected", shellKind: "zsh" });

    sub.onPublication?.({
      channel: `terminal:${SCOPE.attachId}`,
      data: makeFrameBytes({
        case: "snapshot",
        value: { outputSeq: 1, final: true, bytes: new TextEncoder().encode("$ ") },
      }),
    });
    sub.onPublication?.({
      channel: `terminal:${SCOPE.attachId}`,
      data: makeFrameBytes({
        case: "output",
        value: { outputSeq: 2, bytes: new TextEncoder().encode("hi\n") },
      }),
    });
    expect(outputChunks).toEqual(["$ ", "hi\n"]);

    sub.onPublication?.({
      channel: `terminal:${SCOPE.attachId}`,
      data: makeFrameBytes({
        case: "output",
        value: { outputSeq: 4, bytes: new TextEncoder().encode("skip") },
      }),
    });
    expect(states.at(-1)?.status).toBe("disconnected");
    expect(states.at(-1)?.notice).toEqual({ kind: "snapshot_gap" });
    expect(mock.getUnsubscribedCount()).toBe(1);
    controller.dispose();
  });

  test("handles conflict + takeover, backpressure, unauthorized revocation, and readonly constraints", async () => {
    const mock = createMockTransport();
    const states: ComputerTerminalControllerState[] = [];
    const controller = new ComputerTerminalSessionController({
      computerId: SCOPE.computerId,
      transport: mock.transport,
      onStateChange: (next) => states.push(next),
      onOutput: () => {},
    });

    mock.setPrepareResult({ status: "attach_conflict" });
    await controller.connect({ cols: 80, rows: 24, takeover: false, mode: "readonly" });
    expect(states.at(-1)).toMatchObject({ status: "disconnected", notice: { kind: "conflict" } });

    mock.setPrepareResult({
      status: "prepared",
      scope: SCOPE,
      channel: `terminal:${SCOPE.attachId}`,
      subscriptionToken: "tok-2",
      subscriptionExpiresAtMs: Date.now() + 60_000,
      daemonInstanceId: "daemon-1",
      mode: "readonly",
      cols: 120,
      rows: 40,
    });
    await controller.connect({ cols: 80, rows: 24, takeover: true, mode: "readonly" });
    const sub = mock.getSubscription()!;
    sub.onSubscribed?.();
    await Promise.resolve();
    sub.onPublication?.({
      channel: `terminal:${SCOPE.attachId}`,
      data: makeFrameBytes({
        case: "opened",
        value: {
          daemonInstanceId: "daemon-1",
          shellKind: "bash",
          cols: 120,
          rows: 40,
          nextOutputSeq: 1,
          historyUnavailable: true,
        },
      }),
    });
    expect(states.at(-1)).toMatchObject({
      status: "connected",
      mode: "readonly",
      notice: null,
    });

    controller.sendText("rm -rf /\n");
    await controller.resize(40, 20);
    expect(mock.sentInputs).toHaveLength(0);
    expect(mock.resizes).toHaveLength(0);

    sub.onPublication?.({
      channel: `terminal:${SCOPE.attachId}`,
      data: makeFrameBytes({ case: "error", value: { code: "output_backpressure" } }),
    });
    expect(states.at(-1)).toMatchObject({
      status: "disconnected",
      notice: { kind: "output_backpressure" },
    });

    mock.setStatusResult({ unauthorized: true });
    await controller.connect({ cols: 80, rows: 24, takeover: false, mode: "readonly" });
    mock.getSubscription()!.onUnsubscribed?.({ code: 100, reason: "revoked" });
    await Promise.resolve();
    await Promise.resolve();
    expect(states.at(-1)).toMatchObject({
      status: "unauthorized",
      notice: { kind: "unauthorized" },
    });

    await controller.closeShell();
    expect(mock.calls).toContain("close");
    controller.dispose();
  });
});
