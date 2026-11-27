import {
  TERMINAL_MAX_HISTORY_BYTES,
  type ComputerTerminalFrame,
  type TerminalScope,
} from "./computer-terminal-wire";

type TerminalOpen = Pick<TerminalScope, "attachId" | "attachGeneration"> & {
  cols: number;
  rows: number;
  takeover: boolean;
};

export function decideTerminalAttach(
  latest: (TerminalOpen & { active: boolean }) | undefined,
  proposed: TerminalOpen,
): "replace" | "retry" | "stale" | "attach_conflict" {
  if (!latest) return "replace";
  if (latest.attachId === proposed.attachId) {
    if (!latest.active || latest.attachGeneration !== proposed.attachGeneration) return "stale";
    return latest.cols === proposed.cols &&
      latest.rows === proposed.rows &&
      latest.takeover === proposed.takeover
      ? "retry"
      : "attach_conflict";
  }
  if (proposed.attachGeneration <= latest.attachGeneration) return "stale";
  return !latest.active || proposed.takeover ? "replace" : "attach_conflict";
}

export function isCurrentTerminalAttach(current: TerminalScope, received: TerminalScope): boolean {
  return (
    received.protocolMajor === current.protocolMajor &&
    received.workspaceId === current.workspaceId &&
    received.computerId === current.computerId &&
    received.ownerUserId === current.ownerUserId &&
    received.sessionId === current.sessionId &&
    received.attachId === current.attachId &&
    received.attachGeneration === current.attachGeneration
  );
}

export class TerminalSnapshotReplay {
  #opened: ComputerTerminalFrame;
  #watermark: number;
  #next: number;
  #snapshotBytes = 0;
  #complete: boolean;
  #failed = false;

  constructor(opened: ComputerTerminalFrame) {
    if (opened.event.case !== "opened") throw new Error("snapshot_gap");
    this.#opened = { ...opened };
    const { nextOutputSeq, historyUnavailable } = opened.event.value;
    this.#watermark = nextOutputSeq;
    this.#complete = historyUnavailable;
    if (historyUnavailable) {
      this.#next = nextOutputSeq;
    } else {
      this.#next = nextOutputSeq === 1 ? 0 : 1;
    }
  }

  get complete(): boolean {
    return this.#complete && !this.#failed;
  }

  accept(frame: ComputerTerminalFrame): void {
    if (!isCurrentTerminalAttach(this.#opened, frame)) throw new Error("permission_denied");
    if (this.#failed) this.#gap();
    const { event } = frame;
    if (this.#complete) {
      if (event.case !== "output" || event.value.outputSeq !== this.#next) this.#gap();
      this.#next++;
      return;
    }
    const lastSnapshotChunk = this.#next === this.#watermark - 1;
    if (
      event.case !== "snapshot" ||
      event.value.outputSeq !== this.#next ||
      event.value.final !== lastSnapshotChunk ||
      this.#snapshotBytes + event.value.bytes.byteLength > TERMINAL_MAX_HISTORY_BYTES
    ) {
      this.#gap();
    }
    this.#snapshotBytes += event.value.bytes.byteLength;
    this.#next++;
    this.#complete = lastSnapshotChunk;
  }

  #gap(): never {
    this.#failed = true;
    throw new Error("snapshot_gap");
  }
}
