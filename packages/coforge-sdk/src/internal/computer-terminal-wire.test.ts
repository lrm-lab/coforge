import { expect, test } from "bun:test";
import {
  decodeTerminalControl,
  decodeTerminalFrame,
  encodeTerminalControl,
  encodeTerminalFrame,
  TERMINAL_MAX_CHUNK_BYTES,
} from "./computer-terminal-wire";

const scope = {
  protocolMajor: 1,
  workspaceId: "workspace",
  computerId: "computer",
  ownerUserId: "owner",
  sessionId: "session",
  attachId: "attach",
  attachGeneration: 3,
};

test("keeps raw terminal bytes and the complete attach identity in both directions", () => {
  const bytes = Uint8Array.of(0, 27, 255);
  const control = { ...scope, command: { case: "input", value: { inputSeq: 1, bytes } } } as const;
  const frame = { ...scope, event: { case: "output", value: { outputSeq: 1, bytes } } } as const;
  expect(decodeTerminalControl(encodeTerminalControl(control))).toEqual(control);
  expect(decodeTerminalFrame(encodeTerminalFrame(frame))).toEqual(frame);
  expect(() => decodeTerminalControl(encodeTerminalFrame(frame))).toThrow();
});

test("rejects invalid control versions, identity, sizes and sequence numbers", () => {
  const resize = { ...scope, command: { case: "resize", value: { cols: 80, rows: 24 } } } as const;
  const encoded = encodeTerminalControl(resize);
  expect(decodeTerminalControl(encoded)).toEqual(resize);
  const changedVersion = Uint8Array.from(encoded);
  changedVersion[1] = 2;
  expect(() => decodeTerminalControl(changedVersion)).toThrow();
  expect(() => encodeTerminalControl({ ...resize, attachId: "" })).toThrow();
  expect(() => encodeTerminalControl({ ...resize, attachGeneration: 0 })).toThrow();
  expect(() =>
    encodeTerminalControl({ ...scope, command: { case: "resize", value: { cols: 0, rows: 24 } } }),
  ).toThrow();
  expect(() =>
    encodeTerminalControl({
      ...scope,
      command: { case: "input", value: { inputSeq: 0, bytes: Uint8Array.of(1) } },
    }),
  ).toThrow();
});

test("bounds binary output, keeps empty final snapshots and restricts error codes", () => {
  const event = {
    case: "snapshot",
    value: { outputSeq: 0, bytes: new Uint8Array(), final: true },
  } as const;
  expect(decodeTerminalFrame(encodeTerminalFrame({ ...scope, event }))).toEqual({
    ...scope,
    event,
  });
  expect(() =>
    encodeTerminalFrame({
      ...scope,
      event: {
        case: "output",
        value: { outputSeq: 1, bytes: new Uint8Array(TERMINAL_MAX_CHUNK_BYTES + 1) },
      },
    }),
  ).toThrow();
  expect(() =>
    encodeTerminalFrame({ ...scope, event: { case: "error", value: { code: "unexpected" } } }),
  ).toThrow();
});

test("round-trips all supported control cases without an EOF operation", () => {
  const commands = [
    { case: "openOrAttach", value: { cols: 100, rows: 40, takeover: true } },
    { case: "detach", value: {} },
    { case: "close", value: {} },
  ] as const;
  for (const command of commands) {
    const control = { ...scope, command };
    expect(decodeTerminalControl(encodeTerminalControl(control))).toEqual(control);
  }
  const detach = encodeTerminalControl({ ...scope, command: { case: "detach", value: {} } });
  const unsupportedCommand = Uint8Array.of(...detach.subarray(0, -2), 0x82, 0x01, 0x00);
  expect(() => decodeTerminalControl(unsupportedCommand)).toThrow(
    "Invalid computer terminal command",
  );
});

test("round-trips opened, input acceptance, exit code zero, exit signal, error and close", () => {
  const events = [
    {
      case: "opened",
      value: {
        daemonInstanceId: "daemon",
        shellKind: "zsh",
        cols: 80,
        rows: 24,
        nextOutputSeq: 1,
        historyUnavailable: false,
      },
    },
    { case: "inputAccepted", value: { inputSeq: 1 } },
    { case: "exit", value: { status: { case: "code", value: 0 } } },
    { case: "exit", value: { status: { case: "signal", value: "SIGTERM" } } },
    { case: "error", value: { code: "attach_conflict" } },
    { case: "closed", value: { reason: "closed" } },
  ] as const;
  for (const event of events) {
    const frame = { ...scope, event };
    expect(decodeTerminalFrame(encodeTerminalFrame(frame))).toEqual(frame);
  }
});
