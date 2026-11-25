// Sanitizes stdio before running non-interactive repository checks. On macOS, a Node.js child
// accessing `process.stdin`/`stdout`/`stderr` on a PTY slave whose master side has closed blocks
// indefinitely at 0% CPU inside libuv `uv_tty_init` -> `open("/dev/ttysNNN", O_RDWR)`, and Rust
// tools writing to a dead PTY abort on EIO. Replacing dead PTY fds (and detaching stdin for
// non-interactive checks) with `/dev/null` keeps live interactive TTYs, pipes, and CI untouched
// while guaranteeing bounded exits.
//
// usage: bun scripts/ci/safe-stdio.ts <command> [args...]
import { dlopen, FFIType, ptr, type Pointer } from "bun:ffi";
import { isatty } from "node:tty";

const POLLIN = 0x0001;
const POLLOUT = 0x0004;
const POLLERR = 0x0008;
const POLLHUP = 0x0010;
const POLLNVAL = 0x0020;

type PollFn = (fds: Pointer, nfds: number, timeout: number) => number;

let cachedPoll: PollFn | null | undefined;

function loadPosixPoll(): PollFn | null {
  if (cachedPoll !== undefined) return cachedPoll;
  if (process.platform !== "darwin" && process.platform !== "linux") {
    cachedPoll = null;
    return null;
  }
  const libc = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
  try {
    const library = dlopen(libc, {
      poll: { args: [FFIType.ptr, FFIType.usize, FFIType.i32], returns: FFIType.i32 },
    });
    cachedPoll = library.symbols.poll;
  } catch {
    cachedPoll = null;
  }
  return cachedPoll;
}

/** True when `fd` is a TTY/PTY whose peer/master side has already hung up (POLLHUP/POLLERR/POLLNVAL).
 * Uses non-blocking `poll(2)` with timeout 0, which never blocks, writes, or raises SIGTTIN/SIGTTOU. */
export function isClosedPtyFd(fd: number): boolean {
  if (!isatty(fd)) return false;
  const poll = loadPosixPoll();
  if (!poll) return false;
  const buffer = new ArrayBuffer(8);
  const fdView = new Int32Array(buffer, 0, 1);
  const eventView = new Int16Array(buffer, 4, 2);
  fdView[0] = fd;
  eventView[0] = POLLIN | POLLOUT;
  eventView[1] = 0;
  const ready = poll(ptr(new Uint8Array(buffer)), 1, 0);
  if (ready <= 0) return false;
  return ((eventView[1] ?? 0) & (POLLHUP | POLLERR | POLLNVAL)) !== 0;
}

export type StdioMode = "ignore" | "inherit";

/** Computes child stdio modes: detaches `stdin` when requested (preventing mid-run PTY close races
 * for non-interactive checks), and replaces any already-closed PTY fd with `"ignore"` (`/dev/null`)
 * while leaving live TTYs, pipes, and redirected files inherited unchanged. */
export function sanitizedStdio(
  options: { detachStdin?: boolean } = {},
): [StdioMode, StdioMode, StdioMode] {
  const stdin: StdioMode = options.detachStdin || isClosedPtyFd(0) ? "ignore" : "inherit";
  const stdout: StdioMode = isClosedPtyFd(1) ? "ignore" : "inherit";
  const stderr: StdioMode = isClosedPtyFd(2) ? "ignore" : "inherit";
  return [stdin, stdout, stderr];
}

async function main(command: string[]): Promise<never> {
  if (command.length === 0) {
    console.error("usage: bun scripts/ci/safe-stdio.ts <command> [args...]");
    process.exit(2);
  }
  let child: Bun.Subprocess | undefined;
  const forward = (signal: NodeJS.Signals) => () => child?.kill(signal);
  const signals = ["SIGINT", "SIGTERM"] as const;
  const handlers = signals.map((signal) => [signal, forward(signal)] as const);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    child = Bun.spawn(command, {
      stdio: sanitizedStdio({ detachStdin: true }),
    });
    await child.exited;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
  if (child.signalCode) process.kill(process.pid, child.signalCode);
  process.exit(child.exitCode ?? 1);
}

if (import.meta.main) await main(process.argv.slice(2));
