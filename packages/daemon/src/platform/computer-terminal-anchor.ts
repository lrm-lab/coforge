import { dlopen, FFIType } from "bun:ffi";
import { linuxProcessTable } from "./linux-process-table";

export const TERMINAL_CLEANUP_TIMEOUT_MS = 3_000;

async function liveProcessIds(): Promise<number[]> {
  if (process.platform === "linux")
    return (await linuxProcessTable.list()).map((entry) => entry.pid);

  const listing = Bun.spawn(["/bin/ps", "-axo", "pid=,stat="], {
    env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 1_000,
  });
  const [output, code] = await Promise.all([new Response(listing.stdout).text(), listing.exited]);
  if (code !== 0) throw new Error("Terminal process table unavailable");
  return output
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*([1-9]\d*)\s+(\S+)\s*$/.exec(line);
      if (!match) throw new Error("Invalid terminal process table");
      return match[2]!.startsWith("Z") ? [] : [Number(match[1])];
    });
}

export async function runComputerTerminalAnchor(command: string[]): Promise<void> {
  if (!process.connected || !process.send) return;
  if (!command[0]?.startsWith("/")) throw new Error("Invalid terminal anchor launch");

  const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    getsid: { args: [FFIType.i32], returns: FFIType.i32 },
  });
  const { getsid } = libc.symbols;
  const stopping = Promise.withResolvers<void>();
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const)
    process.once(signal, stopping.resolve);
  process.once("disconnect", stopping.resolve);
  process.on("message", () => {});
  try {
    if (getsid(0) !== process.pid || !process.stdin.isTTY)
      throw new Error("Terminal anchor must lead its own PTY session");
    if (!process.connected) return;
    const shell = Bun.spawn({
      cmd: command,
      env: {
        HOME: Bun.env.HOME,
        USER: Bun.env.USER,
        LOGNAME: Bun.env.LOGNAME,
        SHELL: Bun.env.SHELL,
        TMPDIR: Bun.env.TMPDIR,
        TERM: Bun.env.TERM,
        COLORTERM: Bun.env.COLORTERM,
        PATH: Bun.env.PATH,
        LANG: Bun.env.LANG,
      },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.send({ type: "ready" });
    void shell.exited.then((code) => {
      if (process.connected) process.send?.({ type: "exit", code, signal: shell.signalCode });
    });
    await stopping.promise;

    const deadline = performance.now() + TERMINAL_CLEANUP_TIMEOUT_MS;
    for (;;) {
      const members = (await liveProcessIds()).filter(
        (pid) => pid > 1 && pid !== process.pid && getsid(pid) === process.pid,
      );
      if (members.length === 0) break;
      for (const pid of members) {
        if (getsid(pid) !== process.pid) continue;
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as { code?: string }).code !== "ESRCH") throw error;
        }
      }
      if (performance.now() >= deadline) throw new Error("Terminal session still has live members");
      await Bun.sleep(20);
    }
    await shell.exited;
  } finally {
    libc.close();
  }
}

if (import.meta.main) {
  await runComputerTerminalAnchor(process.argv.slice(2));
  process.exit(0);
}
