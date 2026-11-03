import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { invokedDirectory } from "./cleanup";
import {
  commandOf,
  discoverProcesses,
  DISCOVERY_TIMEOUT_MILLISECONDS,
  hiddenOwnProcess,
  realUid,
} from "./cleanup-discovery";
import type { CommandResult, Runner } from "./cleanup-exec";
import { procTree, removeTempDirs } from "./cleanup-test-repo";

afterEach(removeTempDirs);

const roots = ["/repo"];

describe("Linux discovery from /proc", () => {
  test("reads each process's directory and command line, and marks a deleted directory", async () => {
    // The reading process is the one /proc/self names (3001 here), not this test's own pid.
    const procRoot = await procTree(
      [
        { pid: 3001, cwd: "/repo/.worktrees/own", args: ["bun", "cleanup.ts"] },
        { pid: 2001, cwd: "/repo/.worktrees/a/src", args: ["/bin/zsh", "-l"] },
        { pid: 2002, cwd: "/repo/.worktrees/gone (deleted)", args: ["/usr/bin/bun", "proxy.ts"] },
        { pid: 2003, cwd: "/unrelated", args: ["node", "x.js"] },
        { pid: 2004 },
      ],
      3001,
    );

    const found = await discoverProcesses(roots, { platform: "linux", procRoot });

    expect(found.sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 2001, command: "/bin/zsh -l", cwd: "/repo/.worktrees/a/src", cwdExists: false },
      {
        pid: 2002,
        command: "/usr/bin/bun proxy.ts",
        cwd: "/repo/.worktrees/gone",
        cwdExists: false,
      },
    ]);
  });

  test("an existing directory reads as existing", async () => {
    const procRoot = await procTree([{ pid: process.pid, cwd: "/elsewhere" }]);
    const here = import.meta.dir;
    const withLive = await procTree([
      { pid: process.pid, cwd: "/elsewhere" },
      { pid: 2001, cwd: here, args: ["sleep", "30"] },
    ]);
    expect(await discoverProcesses([here], { platform: "linux", procRoot: withLive })).toEqual([
      { pid: 2001, command: "sleep 30", cwd: here, cwdExists: true },
    ]);
    expect(await discoverProcesses([here], { platform: "linux", procRoot })).toEqual([]);
  });

  test("fails when the scan does not find this process with its directory", async () => {
    const procRoot = await procTree([{ pid: 2001, cwd: "/repo/x", args: ["zsh"] }]);
    await expect(discoverProcesses(roots, { platform: "linux", procRoot })).rejects.toThrow(
      "did not find this process",
    );
  });

  test("fails on a process of ours whose directory cannot be read, but not on one that exited", async () => {
    const procRoot = await procTree([
      { pid: process.pid, cwd: "/elsewhere" },
      { pid: 2001, unreadable: true, args: ["zsh"] },
    ]);
    await expect(discoverProcesses(roots, { platform: "linux", procRoot })).rejects.toThrow(
      "cannot read pid 2001",
    );
  });

  // GitHub's runner: systemd's `(sd-pam)` has the runner's uid, gids and no capabilities, yet the
  // kernel refuses its cwd. As on macOS, only an unplaced shell or dev runtime fails the scan.
  test("skips an unreadable process that is no shell or dev runtime, but not one without a command line", async () => {
    const scan = async (args: string[]) =>
      (
        await discoverProcesses(roots, {
          platform: "linux",
          procRoot: await procTree([
            { pid: process.pid, cwd: "/elsewhere" },
            { pid: 2001, unreadable: true, args },
            { pid: 2002, cwd: "/repo/x", args: ["zsh"] },
          ]),
        })
      ).map((found) => found.pid);
    expect(await scan(["(sd-pam)"])).toEqual([2002]);
    expect(await scan(["/usr/bin/gnome-keyring-daemon", "--start"])).toEqual([2002]);
    await expect(scan(["/usr/bin/node", "server.js"])).rejects.toThrow("cannot read pid 2001");
    await expect(scan([])).rejects.toThrow("cannot read pid 2001");
  });

  test("fails when /proc/self does not name a process in the tree", async () => {
    const procRoot = await procTree([{ pid: 2001, cwd: "/repo/x", args: ["zsh"] }], 9999);
    await expect(discoverProcesses(roots, { platform: "linux", procRoot })).rejects.toThrow(
      "did not find this process",
    );
  });

  test("a root-owned /proc entry whose status shows our uid is a hidden process of ours", () => {
    const status = (uid: number) => `Name:\tx\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
    expect(realUid(status(1000))).toBe(1000);
    expect(realUid("Name:\tx\n")).toBeUndefined();
    expect(hiddenOwnProcess(0, status(1000), 1000)).toBe(true);
    expect(hiddenOwnProcess(0, status(0), 1000)).toBe(false);
    expect(hiddenOwnProcess(0, status(2000), 1000)).toBe(false);
    expect(hiddenOwnProcess(1000, status(1000), 1000)).toBe(false);
    expect(hiddenOwnProcess(0, status(0), 0)).toBe(false);
  });

  test("commandOf reads the command line, and nothing for a pid that is gone", async () => {
    const procRoot = await procTree([{ pid: 2001, cwd: "/repo/x", args: ["bun", "a b.ts"] }]);
    const options = { platform: "linux", procRoot };
    expect(await commandOf(2001, options)).toBe("bun a b.ts");
    expect(await commandOf(2999, options)).toBeUndefined();
  });
});

describe("macOS discovery with lsof", () => {
  const done = (stdout: string, overrides: Partial<CommandResult> = {}): CommandResult => ({
    ok: true,
    stdout,
    stderr: "",
    timedOut: false,
    ...overrides,
  });
  const self = `p${process.pid}\ncbun\nfcwd\nn/elsewhere\n`;
  const runner =
    (lsof: CommandResult, calls: { command: string[]; timeout?: number }[] = []): Runner =>
    async (command, options) => {
      calls.push({ command, timeout: options?.timeout });
      return command[0] === "ps" ? done("  301 /bin/zsh -l\n") : lsof;
    };

  test("lists processes inside the roots, and gives lsof a timeout", async () => {
    const calls: { command: string[]; timeout?: number }[] = [];
    const lsof = done(`${self}p301\nczsh\nfcwd\nn/repo/.worktrees/a\np302\nczsh\nfcwd\nn/other\n`);

    const found = await discoverProcesses(roots, {
      platform: "darwin",
      run: runner(lsof, calls),
    });

    expect(found).toEqual([
      { pid: 301, command: "/bin/zsh -l", cwd: "/repo/.worktrees/a", cwdExists: false },
    ]);
    expect(calls.find((call) => call.command[0] === "lsof")?.timeout).toBe(
      DISCOVERY_TIMEOUT_MILLISECONDS,
    );
  });

  test("fails when ps shows a live shell or runtime that lsof left out", async () => {
    const psLines = "  301 /bin/zsh -l\n  302 -zsh\n  303 /usr/bin/ssh host\n  304 node x.js\n";
    const lsof = done(`${self}p301\nczsh\nfcwd\nn/repo/a\n`);
    const withLive =
      (alive: string[]): Runner =>
      async (command) => {
        if (command[0] === "ps" && command[1] === "-x") return done(psLines);
        if (command[0] === "ps")
          return alive.includes(command[2]!) ? done("x") : done("", { ok: false });
        return lsof;
      };

    await expect(
      discoverProcesses(roots, { platform: "darwin", run: withLive(["302"]) }),
    ).rejects.toThrow("lsof did not list pid 302 (-zsh)");
    await expect(
      discoverProcesses(roots, { platform: "darwin", run: withLive(["304"]) }),
    ).rejects.toThrow("pid 304 (node x.js)");
    // A listed-by-ps pid that exited meanwhile, and a program that is not watched, are ignored.
    expect(await discoverProcesses(roots, { platform: "darwin", run: withLive(["303"]) })).toEqual([
      { pid: 301, command: "/bin/zsh -l", cwd: "/repo/a", cwdExists: false },
    ]);
  });

  test("fails when lsof fails, times out, or does not list this process", async () => {
    const attempts: [CommandResult, string][] = [
      [done(self, { ok: false, stderr: "boom" }), "lsof failed: boom"],
      [done("", { ok: false, timedOut: true }), "lsof timed out"],
      [done("p301\nczsh\nfcwd\nn/repo/a\n"), "did not list this process"],
      [done(""), "did not list this process"],
    ];
    for (const [lsof, message] of attempts)
      await expect(
        discoverProcesses(roots, { platform: "darwin", run: runner(lsof) }),
      ).rejects.toThrow(message);
  });
});

describe("other platforms", () => {
  test("Windows has no scan and reports no process", async () => {
    expect(await discoverProcesses(roots, { platform: "win32" })).toEqual([]);
  });

  test("an unsupported platform fails", async () => {
    await expect(discoverProcesses(roots, { platform: "plan9" })).rejects.toThrow(
      "supports macOS, Linux and Windows only, not plan9",
    );
  });
});

describe("invokedDirectory", () => {
  test("mise's original directory wins over the config root it runs the task in", () => {
    expect(invokedDirectory({ MISE_ORIGINAL_CWD: join("/a", "b") }, "/root")).toBe(join("/a", "b"));
    expect(invokedDirectory({}, "/root")).toBe("/root");
  });
});
