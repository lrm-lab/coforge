import { expect, test } from "bun:test";
import type {
  ComputerTerminalControl,
  ComputerTerminalFrame,
} from "@lrm/coforge-sdk/internal/computer-terminal-wire";
import { ComputerTerminalRelay } from "#src/daemon-runtime/computer-terminal-relay";
import { ComputerTerminalSession } from "#src/daemon-runtime/computer-terminal-session";

const scope = {
  protocolMajor: 1,
  workspaceId: "workspace",
  computerId: "computer",
  ownerUserId: "owner",
  sessionId: "session",
  attachId: "first",
  attachGeneration: 1,
};
const next = { ...scope, attachId: "second", attachGeneration: 2 };
const open = (value = scope, takeover = false): ComputerTerminalControl => ({
  ...value,
  command: { case: "openOrAttach", value: { cols: 80, rows: 24, takeover } },
});

function fixture(send: (frame: ComputerTerminalFrame) => Promise<void>) {
  let onOutput: (bytes: Uint8Array) => void = () => {};
  let closed = false;
  const exited = Promise.withResolvers<{ code: number; signal: null }>();
  const relay = new ComputerTerminalRelay({
    ...scope,
    daemonInstanceId: "daemon",
    send,
    create: (binding) =>
      new ComputerTerminalSession({
        ...binding,
        async spawn(_dimensions, receive) {
          onOutput = receive;
          return {
            shellKind: "sh",
            shellExited: exited.promise,
            async close() {
              closed = true;
              exited.resolve({ code: 0, signal: null });
            },
            async write() {},
            resize() {},
          };
        },
      }),
  });
  return {
    relay,
    output(bytes: Uint8Array) {
      onOutput(bytes);
    },
    get closed() {
      return closed;
    },
  };
}

test("skips an oversized replay queue while retaining the detached shell and next sequence", async () => {
  const opened = Promise.withResolvers<ComputerTerminalFrame["event"]>();
  const trial = fixture(async (frame) => {
    if (frame.attachId === next.attachId && frame.event.case === "opened")
      opened.resolve(frame.event);
  });
  try {
    await trial.relay.control(open());
    await trial.relay.control({ ...scope, command: { case: "detach", value: {} } });
    for (let i = 0; i < 1200; i++) trial.output(Uint8Array.of(1));
    await trial.relay.control(open(next));
    expect(await opened.promise).toMatchObject({
      case: "opened",
      value: { historyUnavailable: true, nextOutputSeq: 1201 },
    });
    expect(trial.closed).toBe(false);
  } finally {
    await trial.relay.stop();
  }
});

test("a rejected frame from a replaced lease leaves the new lease and its frames intact", async () => {
  const rejected = Promise.withResolvers<void>();
  const outputStarted = Promise.withResolvers<void>();
  const nextOpened = Promise.withResolvers<void>();
  const live = Promise.withResolvers<ComputerTerminalFrame>();
  const trial = fixture(async (frame) => {
    if (frame.attachId === scope.attachId && frame.event.case === "output") {
      outputStarted.resolve();
      await rejected.promise;
    }
    if (frame.attachId === next.attachId && frame.event.case === "opened") nextOpened.resolve();
    if (frame.attachId === next.attachId && frame.event.case === "output") live.resolve(frame);
  });
  try {
    await trial.relay.control(open());
    trial.output(Uint8Array.of(1));
    await outputStarted.promise;
    await trial.relay.control(open(next, true));
    rejected.reject(new Error("old attach revoked"));
    await nextOpened.promise;
    trial.output(Uint8Array.of(2));
    expect(await live.promise).toMatchObject({
      ...next,
      event: { case: "output", value: { outputSeq: 2 } },
    });
    expect(trial.closed).toBe(false);
  } finally {
    rejected.resolve();
    await trial.relay.stop();
  }
});
