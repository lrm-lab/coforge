import { expect, test } from "bun:test";
import {
  decodeTerminalControl,
  decodeTerminalFrame,
  encodeTerminalControl,
  encodeTerminalFrame,
  type ComputerTerminalFrame,
} from "./computer-terminal-wire";
import {
  decideTerminalAttach,
  isCurrentTerminalAttach,
  TerminalSnapshotReplay,
} from "./computer-terminal-replay";

const scope = {
  protocolMajor: 1,
  workspaceId: "workspace",
  computerId: "computer",
  ownerUserId: "owner",
  sessionId: "session",
  attachId: "attach",
  attachGeneration: 4,
};

function replay(nextOutputSeq: number, historyUnavailable = false) {
  return new TerminalSnapshotReplay(
    wire({
      case: "opened",
      value: {
        daemonInstanceId: "daemon",
        shellKind: "zsh",
        cols: 80,
        rows: 24,
        nextOutputSeq,
        historyUnavailable,
      },
    }),
  );
}

function wire(event: ComputerTerminalFrame["event"]): ComputerTerminalFrame {
  return decodeTerminalFrame(encodeTerminalFrame({ ...scope, event }));
}

function snapshot(outputSeq: number, final = false): ComputerTerminalFrame {
  return wire({
    case: "snapshot",
    value: {
      outputSeq,
      bytes: outputSeq === 0 ? new Uint8Array() : Uint8Array.of(outputSeq),
      final,
    },
  });
}

function output(outputSeq: number): ComputerTerminalFrame {
  return wire({ case: "output", value: { outputSeq, bytes: Uint8Array.of(outputSeq) } });
}

test("requires explicit takeover of an active lease and exact parameters on a retry", () => {
  const latest = { attachGeneration: 4, attachId: "current", cols: 80, rows: 24, takeover: false };
  const activeLease = { ...latest, active: true };
  const next = { ...latest, attachGeneration: 5, attachId: "next" };
  expect(decideTerminalAttach(undefined, latest)).toBe("replace");
  expect(decideTerminalAttach(activeLease, latest)).toBe("retry");
  expect(decideTerminalAttach(activeLease, { ...latest, cols: 100 })).toBe("attach_conflict");
  expect(decideTerminalAttach(activeLease, { ...latest, takeover: true })).toBe("attach_conflict");
  expect(decideTerminalAttach(activeLease, next)).toBe("attach_conflict");
  expect(decideTerminalAttach(activeLease, { ...next, takeover: true })).toBe("replace");
  expect(decideTerminalAttach({ ...activeLease, active: false }, next)).toBe("replace");
  for (const attachGeneration of [2, 4]) {
    const stale = { ...next, attachGeneration, takeover: true };
    expect(decideTerminalAttach(activeLease, stale)).toBe("stale");
    expect(decideTerminalAttach({ ...activeLease, active: false }, stale)).toBe("stale");
  }
});

test("fences delayed input and output from the previous lease after takeover", () => {
  const current = { ...scope, attachId: "next", attachGeneration: 5 };
  const command = { case: "input", value: { inputSeq: 1, bytes: Uint8Array.of(4) } } as const;
  const delayedInput = decodeTerminalControl(encodeTerminalControl({ ...scope, command }));
  expect(isCurrentTerminalAttach(current, delayedInput)).toBe(false);
  expect(isCurrentTerminalAttach(current, output(1))).toBe(false);
  const input = decodeTerminalControl(encodeTerminalControl({ ...current, command }));
  expect(isCurrentTerminalAttach(current, input)).toBe(true);
});

test("continues without replay at the opened sequence when history is unavailable", () => {
  const continued = replay(12, true);
  expect(continued.complete).toBe(true);
  continued.accept(output(12));
  continued.accept(output(13));
  expect(() => replay(12, true).accept(snapshot(1))).toThrow("snapshot_gap");
  expect(() => replay(12, true).accept(output(13))).toThrow("snapshot_gap");
});

test("replays original chunks from 1 through the opened watermark before contiguous live output", () => {
  const history = replay(4);
  history.accept(snapshot(1));
  history.accept(snapshot(2));
  expect(history.complete).toBe(false);
  history.accept(snapshot(3, true));
  expect(history.complete).toBe(true);
  history.accept(output(4));
  history.accept(output(5));
  expect(() => history.accept(output(7))).toThrow("snapshot_gap");
});

test("accepts only the empty final seq 0 snapshot when no bytes have ever been emitted", () => {
  const history = replay(1);
  history.accept(snapshot(0, true));
  expect(history.complete).toBe(true);
  history.accept(output(1));
  expect(() => replay(2).accept(snapshot(0, true))).toThrow("snapshot_gap");
  expect(() => replay(1).accept(output(1))).toThrow("snapshot_gap");
});

test("rejects gaps, out-of-order chunks, truncation, false final and cross-attach replay", () => {
  expect(() => replay(4).accept(snapshot(2))).toThrow("snapshot_gap");
  expect(() => replay(4).accept(snapshot(1, true))).toThrow("snapshot_gap");
  const history = replay(4);
  history.accept(snapshot(1));
  expect(() => history.accept(snapshot(3, true))).toThrow("snapshot_gap");
  expect(() => history.accept(snapshot(2))).toThrow("snapshot_gap");
  const incomplete = replay(2);
  expect(() => incomplete.accept(snapshot(1))).toThrow("snapshot_gap");
  const current = replay(2);
  expect(() => current.accept({ ...snapshot(1, true), attachId: "another" })).toThrow(
    "permission_denied",
  );
  expect(() => current.accept({ ...snapshot(1, true), attachGeneration: 3 })).toThrow(
    "permission_denied",
  );
  current.accept(snapshot(1, true));
  expect(current.complete).toBe(true);
});

test("accepts at most one MiB of replay even when every chunk sequence is contiguous", () => {
  const fullChunk = new Uint8Array(16 * 1024);
  const fullHistory = replay(65);
  const history = replay(66);
  for (let outputSeq = 1; outputSeq <= 64; outputSeq++) {
    const chunk = wire({ case: "snapshot", value: { outputSeq, bytes: fullChunk, final: false } });
    history.accept(chunk);
    fullHistory.accept(
      wire({ case: "snapshot", value: { outputSeq, bytes: fullChunk, final: outputSeq === 64 } }),
    );
  }
  expect(fullHistory.complete).toBe(true);
  fullHistory.accept(output(65));
  expect(() => history.accept(snapshot(65, true))).toThrow("snapshot_gap");
});
