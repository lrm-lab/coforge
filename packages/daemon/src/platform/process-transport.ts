import type { OwnedChildProcess, ProcessTreeSpawnOptions } from "@lrm/coforge-anvil";

/** Shared pipe/terminal transport; process groups, launchd and Jobs remain the owner's concern. */
export function spawnOwnedChild(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  options?: ProcessTreeSpawnOptions & { detached?: boolean },
): OwnedChildProcess {
  if (!options?.terminal) {
    const child = Bun.spawn({
      cmd: [...command],
      cwd,
      env: { ...environment },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      detached: options?.detached ?? false,
      windowsHide: true,
    });
    return {
      get pid() {
        return child.pid;
      },
      exited: child.exited,
      get exitCode() {
        return child.exitCode;
      },
      stdin: {
        write(value) {
          child.stdin.write(value);
          return true;
        },
        end() {
          child.stdin.end();
        },
        async flush() {
          await child.stdin.flush();
        },
      },
      stdout: child.stdout,
      stderr: child.stderr,
      kill(signal) {
        child.kill(signal);
      },
    };
  }
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let cancelled = false;
  const stdout = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      cancelled = true;
    },
  });
  const finish = () => {
    if (closed) return;
    closed = true;
    if (!cancelled) controller.close();
  };
  const child = Bun.spawn({
    cmd: [...command],
    cwd,
    env: { ...environment },
    detached: options.detached ?? false,
    windowsHide: true,
    terminal: {
      cols: 120,
      rows: 24,
      data(_terminal, data) {
        if (!closed && !cancelled) controller.enqueue(data);
      },
      exit: finish,
    },
  });
  return {
    get pid() {
      return child.pid;
    },
    exited: child.exited,
    get exitCode() {
      return child.exitCode;
    },
    stdin: {
      write(value) {
        child.terminal!.write(value);
        return true;
      },
      end() {
        child.terminal!.close();
        finish();
      },
      async flush() {},
    },
    stdout,
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        c.close();
      },
    }),
    kill(signal) {
      child.kill(signal);
    },
  };
}
