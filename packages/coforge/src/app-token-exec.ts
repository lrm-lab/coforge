import { closeSync, writeSync } from "node:fs";
import { constants } from "node:os";

/** The file descriptor the program reads the token from, named to it by `COFORGE_APP_TOKEN_FD`. */
export const APP_TOKEN_FD = 3;
/** What the token is replaced with wherever the program writes it. */
export const REDACTED = "[REDACTED]";
/** `timeout(1)`'s exit status for a program it had to stop. */
export const TIMED_OUT_EXIT_CODE = 124;
/** A shell's exit status for a program it could not run. */
const NOT_RUN_EXIT_CODE = 127;
/** How long a program stopped at its timeout has to exit before it is killed. */
const KILL_GRACE_MS = 2_000;

type Sink = (chunk: Buffer) => void;

/** What is redacted of `token`: the whole of it and, for a JWT, its signature and its signed part
 * (header and payload), each of which can be printed alone. */
function tokenParts(token: string): Buffer[] {
  const lastDot = token.lastIndexOf(".");
  const parts = lastDot > 0 ? [token, token.slice(0, lastDot), token.slice(lastDot + 1)] : [token];
  return [...new Set(parts.filter((part) => part.length > 0))]
    .sort((a, b) => b.length - a.length)
    .map((part) => Buffer.from(part));
}

/**
 * Replaces every occurrence of `token`, or of its signature or signed part alone, in a byte
 * stream before it reaches `sink`. Only a chunk's tail that could begin one of them is held back
 * until the next chunk, so one split across chunks is still found and other output is not
 * delayed.
 */
export function createRedactor(token: string, sink: Sink) {
  const needles = tokenParts(token);
  const longest = needles[0]?.length ?? 0;
  const replacement = Buffer.from(REDACTED);
  let pending = Buffer.alloc(0);
  /** The first match in `pending` from `from`, the longest one where several start together. */
  const nextMatch = (from: number) => {
    let best: { at: number; length: number } | undefined;
    for (const needle of needles) {
      const at = pending.indexOf(needle, from);
      if (at !== -1 && (!best || at < best.at)) best = { at, length: needle.length };
    }
    return best;
  };
  /** Whether the bytes from `at` on could still grow into a longer match than `length` bytes. */
  const couldGrow = (at: number, length = 0) => {
    const tail = pending.subarray(at);
    return needles.some(
      (needle) =>
        needle.length > Math.max(length, tail.length) &&
        needle.subarray(0, tail.length).equals(tail),
    );
  };
  /** Where the tail that could still grow into a match starts. */
  const heldFrom = () => {
    for (let at = Math.max(0, pending.length - (longest - 1)); at < pending.length; at++)
      if (couldGrow(at)) return at;
    return pending.length;
  };
  /** Passes on what is settled; at the `end` nothing more can follow, so nothing is held. */
  const pass = (end: boolean) => {
    const parts: Buffer[] = [];
    let offset = 0;
    for (let match = nextMatch(0); match; match = nextMatch(offset)) {
      // The signed part, found whole where the whole token may follow in the next chunk.
      if (!end && couldGrow(match.at, match.length)) break;
      parts.push(pending.subarray(offset, match.at), replacement);
      offset = match.at + match.length;
    }
    pending = pending.subarray(offset);
    const held = end ? pending.length : heldFrom();
    parts.push(pending.subarray(0, held));
    pending = pending.subarray(held);
    const out = Buffer.concat(parts);
    if (out.length > 0) sink(out);
  };
  return {
    write(chunk: Buffer) {
      pending = Buffer.concat([pending, chunk]);
      pass(false);
    },
    end() {
      pass(true);
    },
  };
}

/** The program's environment: only the search path, the locale, the time zone and the temporary
 * directory, so no credential of the Agent's or the Computer's reaches it. */
function minimalEnvironment(env: Record<string, string | undefined>) {
  const kept: Record<string, string> = { PATH: env.PATH || "/usr/bin:/bin" };
  for (const [name, value] of Object.entries(env))
    if (value !== undefined && (name === "LANG" || name.startsWith("LC_") || name === "TZ"))
      kept[name] = value;
  if (env.TMPDIR) kept.TMPDIR = env.TMPDIR;
  return { ...kept, COFORGE_APP_TOKEN_FD: String(APP_TOKEN_FD) };
}

export type AppTokenRun = {
  token: string;
  program: string;
  args: readonly string[];
  timeoutSeconds: number;
  /** The CLI's own environment, which the program gets only a few names of. */
  env: Record<string, string | undefined>;
  stdout: Sink;
  stderr: Sink;
};

/** Signals the process group `pid` leads; one that is already gone is not an error. */
function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal);
  } catch {
    // The whole group has exited.
  }
}

/** Whether any process of the group `pid` leads is still there. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stops the whole group: SIGTERM, then SIGKILL for whatever is left after the grace. */
async function stopGroup(pid: number): Promise<void> {
  if (!groupAlive(pid)) return;
  signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline && groupAlive(pid)) await Bun.sleep(50);
  signalGroup(pid, "SIGKILL");
}

/** Passes `stream` through `redactor` until it ends; `cancel` stops reading it early. */
function pump(stream: ReadableStream<Uint8Array>, redactor: ReturnType<typeof createRedactor>) {
  const reader = stream.getReader();
  const done = (async () => {
    try {
      for (let read = await reader.read(); !read.done; read = await reader.read())
        redactor.write(Buffer.from(read.value));
    } catch {
      // Cancelled: what was read has been passed on.
    }
    redactor.end();
  })();
  return { done, cancel: () => void reader.cancel().catch(() => {}) };
}

/** The signals that stop the CLI, and so the program it runs. */
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
type Interruption = { by: "timeout" } | { by: (typeof FORWARDED_SIGNALS)[number] };

/**
 * Runs `program` with the token on file descriptor 3, the CLI's stdin, and a minimal environment;
 * its stdout and stderr pass through with the token redacted. The program runs in a process group
 * of its own, and nothing started in it outlives the command: once the program exits, whatever it
 * left running is stopped too. `timeoutSeconds` bounds the whole command, the program's output
 * included, and SIGTERM, SIGINT or SIGHUP to the CLI stops the group as well. Resolves to the
 * exit code: the program's own, 128 plus the signal that ended it (or that the CLI got), 124 when
 * the command outlived `timeoutSeconds`, or 127 when the program could not be run.
 */
export async function runWithAppToken(run: AppTokenRun): Promise<number> {
  let child: Bun.Subprocess<"inherit", "pipe", "pipe">;
  try {
    child = Bun.spawn([run.program, ...run.args], {
      stdio: ["inherit", "pipe", "pipe", "pipe"],
      env: minimalEnvironment(run.env),
      // Its own process group, so stopping it reaches everything it started too.
      detached: true,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    run.stderr(Buffer.from(`coforge: could not run ${run.program}: ${reason}\n`));
    return NOT_RUN_EXIT_CODE;
  }
  const tokenFd = child.stdio[APP_TOKEN_FD];
  if (typeof tokenFd === "number")
    try {
      writeSync(tokenFd, run.token);
    } catch {
      // A program that exits before reading the token closed the pipe: not an error.
    } finally {
      closeSync(tokenFd);
    }
  const out = pump(child.stdout, createRedactor(run.token, run.stdout));
  const err = pump(child.stderr, createRedactor(run.token, run.stderr));

  // Done once the program has exited, what it left running is stopped, and its output has ended.
  const finished = (async () => {
    const exitCode = await child.exited;
    await stopGroup(child.pid);
    await Promise.all([out.done, err.done]);
    return child.signalCode ? 128 + (constants.signals[child.signalCode] ?? 0) : exitCode;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners: [NodeJS.Signals, () => void][] = [];
  const interrupted = new Promise<Interruption>((resolve) => {
    timer = setTimeout(() => resolve({ by: "timeout" }), run.timeoutSeconds * 1000);
    for (const signal of FORWARDED_SIGNALS) {
      const listener = () => resolve({ by: signal });
      listeners.push([signal, listener]);
      process.on(signal, listener);
    }
  });
  try {
    const ending = await Promise.race([finished, interrupted]);
    if (typeof ending === "number") return ending;
    await stopGroup(child.pid);
    // Something outside the group may still hold the output open: stop reading it.
    out.cancel();
    err.cancel();
    await Promise.all([out.done, err.done]);
    if (ending.by !== "timeout") return 128 + constants.signals[ending.by];
    run.stderr(Buffer.from(`coforge: ${run.program} was stopped after ${run.timeoutSeconds}s\n`));
    return TIMED_OUT_EXIT_CODE;
  } finally {
    // Kept until the group is stopped, so a second signal cannot end the CLI half way.
    clearTimeout(timer);
    for (const [signal, listener] of listeners) process.off(signal, listener);
  }
}
