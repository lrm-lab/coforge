import { withDeadline } from "@lrm/coforge-anvil";
import { TERMINAL_MAX_CHUNK_BYTES } from "@lrm/coforge-sdk/internal/computer-terminal-wire";
import { join } from "node:path";

const TERMINAL_STOP_WAIT_MS = 5_000;
const TERMINAL_OUTPUT_WINDOW_MS = 8;

type ShellExit = { code: number; signal: string | null };

type TerminalPtyOptions = {
  command: string[];
  cwd: string;
  environment: Record<string, string>;
  cols: number;
  rows: number;
  onOutput(bytes: Uint8Array): void;
};

export function spawnComputerTerminalPty(options: TerminalPtyOptions) {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("unsupported");

  const anchor = import.meta.path.startsWith("/$bunfs/")
    ? [process.execPath, "__computer-terminal-anchor"]
    : [
        process.execPath,
        "run",
        "--no-env-file",
        join(import.meta.dir, "computer-terminal-anchor.ts"),
      ];
  const ready = Promise.withResolvers<void>();
  const shellExited = Promise.withResolvers<ShellExit>();
  void ready.promise.catch(() => {});
  void shellExited.promise.catch(() => {});
  let pendingWrite: ReturnType<typeof Promise.withResolvers<void>> | undefined;
  let closing: Promise<void> | undefined;
  const batch = new Uint8Array(TERMINAL_MAX_CHUNK_BYTES);
  let batchLength = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    if (!batchLength) return;
    const bytes = batch.slice(0, batchLength);
    batchLength = 0;
    options.onOutput(bytes);
  };
  const child = Bun.spawn({
    cmd: [...anchor, ...options.command],
    cwd: options.cwd,
    env: options.environment,
    terminal: {
      cols: options.cols,
      rows: options.rows,
      data(_terminal, bytes) {
        for (let offset = 0; offset < bytes.byteLength;) {
          const length = Math.min(batch.byteLength - batchLength, bytes.byteLength - offset);
          batch.set(bytes.subarray(offset, offset + length), batchLength);
          batchLength += length;
          offset += length;
          if (batchLength === batch.byteLength) flush();
        }
        if (batchLength && !flushTimer) flushTimer = setTimeout(flush, TERMINAL_OUTPUT_WINDOW_MS);
      },
      drain() {
        pendingWrite?.resolve();
        pendingWrite = undefined;
      },
      exit() {
        flush();
        pendingWrite?.reject(new Error("Terminal PTY closed"));
        pendingWrite = undefined;
      },
    },
    ipc(message: { type: "ready" } | ({ type: "exit" } & ShellExit)) {
      if (message.type === "ready") ready.resolve();
      if (message.type === "exit")
        shellExited.resolve({ code: message.code, signal: message.signal });
    },
  });
  const terminal = child.terminal;
  if (!terminal) {
    child.disconnect();
    throw new Error("Terminal PTY unavailable");
  }
  const exited = child.exited.then((code) => {
    const failure = new Error("Terminal anchor exited");
    ready.reject(failure);
    shellExited.reject(failure);
    pendingWrite?.reject(failure);
    pendingWrite = undefined;
    terminal.close();
    flush();
    return code;
  });

  return {
    ready: ready.promise,
    shellExited: shellExited.promise,
    resize(cols: number, rows: number): void {
      if (closing || terminal.closed) throw new Error("Terminal PTY closed");
      terminal.resize(cols, rows);
    },
    async write(bytes: Uint8Array): Promise<void> {
      if (closing || terminal.closed) throw new Error("Terminal PTY closed");
      if (pendingWrite) throw new Error("Terminal input is backpressured");
      const written = Promise.withResolvers<void>();
      pendingWrite = written;
      try {
        if (terminal.write(bytes) !== bytes.byteLength) throw new Error("Terminal write failed");
      } catch (error) {
        pendingWrite = undefined;
        throw error;
      }
      await written.promise;
    },
    close(): Promise<void> {
      if (closing) return closing;
      pendingWrite?.reject(new Error("Terminal PTY closed"));
      pendingWrite = undefined;
      closing = withDeadline(
        exited,
        TERMINAL_STOP_WAIT_MS,
        () => new Error("Terminal session cleanup timed out"),
      ).then((code) => {
        if (code !== 0) throw new Error("Terminal session cleanup failed");
      });
      child.disconnect();
      return closing;
    },
  };
}
