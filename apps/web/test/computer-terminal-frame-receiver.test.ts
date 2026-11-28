import { describe, expect, test } from "bun:test";
import {
  decodeTerminalFrame,
  encodeTerminalFrame,
  type ComputerTerminalFrame,
} from "@lrm/coforge-sdk/internal/computer-terminal-wire";

import { terminalAttachChannel } from "#src/features/computers/terminal/computer-terminal-channel";
import { createComputerTerminalFrameMethod } from "#src/server/centrifugo/computer-terminal-frame-receiver.server";
import { InMemoryComputerTerminalStore } from "#src/server/computers/computer-terminal-store.server";

const WORKSPACE_ID = "00000000-0000-5000-8000-000000000001";
const COMPUTER_ID = "00000000-0000-5000-8000-000000000002";
const OWNER_ID = "00000000-0000-5000-8000-000000000010";
const SESSION_ID = "ts_session_1";
const ATTACH_ID = "ta_attach_1";

async function createReceiverFixture() {
  const store = new InMemoryComputerTerminalStore();
  await store.saveSession({
    workspaceId: WORKSPACE_ID,
    computerId: COMPUTER_ID,
    ownerUserId: OWNER_ID,
    sessionId: SESSION_ID,
    daemonInstanceId: "daemon-1",
    attachGeneration: 1,
    cols: 80,
    rows: 24,
    activeAttach: {
      attachId: ATTACH_ID,
      attachGeneration: 1,
      loginGeneration: 1,
      mode: "interactive",
      nextInputSeq: 1,
      cols: 80,
      rows: 24,
      opened: false,
      createdAtMs: 1_700_000_000_000,
    },
    updatedAtMs: 1_700_000_000_000,
  });

  const published: { channel: string; frame: ComputerTerminalFrame; skipHistory?: boolean }[] = [];
  const method = createComputerTerminalFrameMethod({
    store,
    publish: async (channel, bytes, options) => {
      published.push({
        channel,
        frame: decodeTerminalFrame(bytes),
        skipHistory: options?.skipHistory,
      });
    },
  });

  return { store, published, method };
}

function makeFrame(
  event: ComputerTerminalFrame["event"],
  overrides: Partial<ComputerTerminalFrame> = {},
): Uint8Array {
  return encodeTerminalFrame({
    protocolMajor: 1,
    workspaceId: WORKSPACE_ID,
    computerId: COMPUTER_ID,
    ownerUserId: OWNER_ID,
    sessionId: SESSION_ID,
    attachId: ATTACH_ID,
    attachGeneration: 1,
    event,
    ...overrides,
  });
}

describe("createComputerTerminalFrameMethod", () => {
  test("rejects malformed frames with 400 and mismatched principals or scopes with 403", async () => {
    const { method, published } = await createReceiverFixture();

    expect(
      await method(new Uint8Array([1, 2, 3]), {
        principal: {
          userId: OWNER_ID,
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          workerInstanceId: "daemon-1",
        },
      }),
    ).toEqual({ code: 400, message: "Invalid computer terminal frame" });

    const validOutput = makeFrame({
      case: "output",
      value: { outputSeq: 1, bytes: new TextEncoder().encode("hi") },
    });

    expect(
      await method(validOutput, {
        principal: {
          userId: OWNER_ID,
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          agentId: "agent-1",
        },
      }),
    ).toEqual({ code: 403, message: "Terminal frame scope is not authorized" });

    expect(
      await method(validOutput, {
        principal: {
          userId: OWNER_ID,
          workspaceId: WORKSPACE_ID,
          computerId: COMPUTER_ID,
          workerInstanceId: "daemon-2",
        },
      }),
    ).toEqual({ code: 403, message: "Terminal attach is not authorized" });

    expect(
      await method(
        makeFrame(
          { case: "output", value: { outputSeq: 1, bytes: new TextEncoder().encode("hi") } },
          { attachId: "ta_other" },
        ),
        {
          principal: {
            userId: OWNER_ID,
            workspaceId: WORKSPACE_ID,
            computerId: COMPUTER_ID,
            workerInstanceId: "daemon-1",
          },
        },
      ),
    ).toEqual({ code: 403, message: "Terminal attach is not authorized" });

    expect(published).toHaveLength(0);
  });

  test("marks attach opened, forwards binary frames, and cleans session on closed or backpressure", async () => {
    const { store, method, published } = await createReceiverFixture();
    const principal = {
      userId: OWNER_ID,
      workspaceId: WORKSPACE_ID,
      computerId: COMPUTER_ID,
      workerInstanceId: "daemon-1",
    };

    const openedResult = await method(
      makeFrame({
        case: "opened",
        value: {
          daemonInstanceId: "daemon-1",
          shellKind: "zsh",
          cols: 80,
          rows: 24,
          nextOutputSeq: 1,
          historyUnavailable: false,
        },
      }),
      { principal },
    );
    expect(openedResult).toBeInstanceOf(Uint8Array);
    const afterOpen = await store.getSession({
      workspaceId: WORKSPACE_ID,
      computerId: COMPUTER_ID,
    });
    expect(afterOpen?.activeAttach?.opened).toBe(true);

    await method(
      makeFrame({
        case: "output",
        value: { outputSeq: 1, bytes: new TextEncoder().encode("hello\r\n") },
      }),
      { principal },
    );
    expect(
      await store.getSession({ workspaceId: WORKSPACE_ID, computerId: COMPUTER_ID }),
    ).toBeDefined();

    await method(makeFrame({ case: "error", value: { code: "output_backpressure" } }), {
      principal,
    });
    expect(
      await store.getSession({ workspaceId: WORKSPACE_ID, computerId: COMPUTER_ID }),
    ).toBeUndefined();

    expect(
      published.map((entry) => [entry.channel, entry.frame.event.case, entry.skipHistory]),
    ).toEqual([
      [terminalAttachChannel(ATTACH_ID), "opened", true],
      [terminalAttachChannel(ATTACH_ID), "output", true],
      [terminalAttachChannel(ATTACH_ID), "error", true],
    ]);
  });
});
