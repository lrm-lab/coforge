import { expect, test } from "bun:test";
import { ComputerTerminalSession } from "#src/daemon-runtime/computer-terminal-session";
import type {
  ComputerTerminalControl,
  ComputerTerminalFrame,
} from "@lrm/coforge-sdk/internal/computer-terminal-wire";

const scope = {
  protocolMajor: 1,
  workspaceId: "workspace",
  computerId: "computer",
  ownerUserId: "owner",
  sessionId: "session",
  attachId: "first",
  attachGeneration: 1,
};
const nextAttach = { ...scope, attachId: "next", attachGeneration: 2 };
const dimensions = { cols: 80, rows: 24 };

function fixture() {
  const events: ComputerTerminalFrame[] = [];
  const writes: number[][] = [];
  let closed = 0;
  let spawned = 0;
  let accepting = true;
  let blockedWrite: Promise<void> | undefined;
  const writeStarted = Promise.withResolvers<void>();
  let ptyOutput: (data: Uint8Array) => void = () => {};
  const shell = Promise.withResolvers<{ code: number; signal: string | null }>();
  const session = new ComputerTerminalSession({
    workspaceId: scope.workspaceId,
    computerId: scope.computerId,
    ownerUserId: scope.ownerUserId,
    daemonInstanceId: "instance",
    async spawn(_dimensions, onOutput) {
      spawned++;
      ptyOutput = onOutput;
      return {
        shellKind: "zsh",
        shellExited: shell.promise,
        async write(bytes) {
          writes.push([...bytes]);
          writeStarted.resolve();
          await blockedWrite;
        },
        resize() {},
        async close() {
          closed++;
          shell.resolve({ code: 0, signal: null });
        },
      };
    },
    emit(frame) {
      if (!accepting && frame.event.case === "output") return false;
      events.push(frame);
      return true;
    },
  });
  return {
    session,
    events,
    writes,
    get spawned() {
      return spawned;
    },
    get closed() {
      return closed;
    },
    output(bytes: Uint8Array) {
      ptyOutput(bytes);
    },
    writeStarted: writeStarted.promise,
    stallWrite(until: Promise<void>) {
      blockedWrite = until;
    },
    saturate() {
      accepting = false;
    },
  };
}

function open(overrides: Partial<typeof scope> = {}, takeover = false): ComputerTerminalControl {
  return {
    ...scope,
    ...overrides,
    command: { case: "openOrAttach", value: { ...dimensions, takeover } },
  };
}

function input(inputSeq: number, overrides: Partial<typeof scope> = {}): ComputerTerminalControl {
  return {
    ...scope,
    ...overrides,
    command: { case: "input", value: { inputSeq, bytes: Uint8Array.of(4) } },
  };
}

test("retains one shell, rejects conflicting leases and fences the old input after takeover", async () => {
  const trial = fixture();
  await trial.session.control(open());
  await trial.session.control(open());
  await trial.session.control(open(nextAttach));
  expect(trial.spawned).toBe(1);
  expect(trial.events.at(-1)?.event).toEqual({ case: "error", value: { code: "attach_conflict" } });
  await trial.session.control(input(1));
  await trial.session.control(input(1));
  await trial.session.control(input(3));
  expect(trial.writes).toEqual([[4]]);
  expect(trial.events.at(-1)?.event).toEqual({ case: "error", value: { code: "input_sequence" } });
  await trial.session.control(open(nextAttach, true));
  await trial.session.control(input(2));
  await trial.session.control(input(1, nextAttach));
  expect(trial.writes).toEqual([[4], [4]]);
  expect(trial.events.at(-1)).toMatchObject({ ...nextAttach, event: { case: "inputAccepted" } });
  await trial.session.stop();
  expect(trial.closed).toBe(1);
  await trial.session.control(open());
  expect(trial.spawned).toBe(1);
});

test("continues live after resize or history overflow without closing the shell", async () => {
  for (const loseHistory of ["resize", "overflow"] as const) {
    const trial = fixture();
    await trial.session.control(open());
    trial.output(Uint8Array.of(1, 2));
    if (loseHistory === "resize") {
      await trial.session.control({
        ...scope,
        command: { case: "resize", value: { cols: 100, rows: 40 } },
      });
    } else {
      trial.output(new Uint8Array(1024 * 1024));
    }
    await trial.session.control({ ...scope, command: { case: "detach", value: {} } });
    const attachStart = trial.events.length;
    await trial.session.control(open(nextAttach));
    const [opened] = trial.events.slice(attachStart);
    expect(trial.events).toHaveLength(attachStart + 1);
    expect(opened?.event).toMatchObject({ case: "opened", value: { historyUnavailable: true } });
    if (opened?.event.case !== "opened") throw new Error("Expected opened");
    trial.output(Uint8Array.of(5));
    expect(trial.events.at(-1)).toMatchObject({
      ...nextAttach,
      event: { case: "output", value: { outputSeq: opened.event.value.nextOutputSeq } },
    });
    expect(trial.closed).toBe(0);
    await trial.session.stop();
  }
});

test("replays the original ordered chunks before live output and closes on output backpressure", async () => {
  const trial = fixture();
  await trial.session.control(open());
  trial.output(Uint8Array.of(1));
  trial.output(Uint8Array.of(2));
  await trial.session.control({ ...scope, command: { case: "detach", value: {} } });
  await trial.session.control(open(nextAttach));
  expect(trial.events.slice(-2).map((frame) => frame.event)).toEqual([
    { case: "snapshot", value: { outputSeq: 1, bytes: Uint8Array.of(1), final: false } },
    { case: "snapshot", value: { outputSeq: 2, bytes: Uint8Array.of(2), final: true } },
  ]);
  trial.saturate();
  trial.output(Uint8Array.of(3));
  await trial.session.stop();
  expect(trial.closed).toBe(1);
  expect(trial.events.slice(-2).map((frame) => frame.event)).toEqual([
    { case: "error", value: { code: "output_backpressure" } },
    { case: "closed", value: { reason: "output_backpressure" } },
  ]);
});

test("ignores an in-flight duplicate without advancing or rejecting its sequence", async () => {
  const trial = fixture();
  const drain = Promise.withResolvers<void>();
  await trial.session.control(open());
  trial.stallWrite(drain.promise);
  const first = trial.session.control(input(1));
  try {
    await trial.writeStarted;
    const eventCount = trial.events.length;
    await trial.session.control(input(1));
    expect(trial.events).toHaveLength(eventCount);
  } finally {
    drain.resolve();
    await first;
    await trial.session.stop();
  }
  expect(trial.writes).toEqual([[4]]);
});

test("rejects foreign scope before launch and never reopens a closed session on delayed frames", async () => {
  const trial = fixture();
  await trial.session.control(open({ ownerUserId: "foreign" }));
  await trial.session.control(open({ computerId: "foreign" }));
  expect(trial.spawned).toBe(0);
  await trial.session.control(open());
  await trial.session.control({ ...scope, command: { case: "close", value: {} } });
  await trial.session.control(open());
  await trial.session.control(input(1));
  expect(trial.spawned).toBe(1);
  expect(trial.closed).toBe(1);
  expect(trial.writes).toEqual([]);
});
