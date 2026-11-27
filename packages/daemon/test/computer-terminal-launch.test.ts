import { expect, test } from "bun:test";
import { resolveComputerTerminalLaunch } from "#src/platform/computer-terminal-launch";

const account = {
  username: "terminal-fixture",
  homedir: "/fixture/home",
  shell: "/fixture/bin/zsh",
};

const inherited = {
  HOME: "/inherited/home",
  USER: "inherited-user",
  LOGNAME: "inherited-login",
  SHELL: "/inherited/bin/sh",
  TMPDIR: "/inherited/tmp",
  TERM: "dumb",
  COLORTERM: "inherited-color",
  PATH: "/inherited/bin",
  LANG: "inherited-locale",
  LC_ALL: "inherited-lc-all",
  LC_CTYPE: "inherited-lc-ctype",
  VENDOR_API_KEY: "fake-key",
  VENDOR_ACCESS_TOKEN: "fake-token",
  COFORGE_AGENT_ID: "fake-agent",
  COFORGE_WORKSPACE_ID: "fake-workspace",
  COFORGE_DAEMON_API_KEY: "fake-daemon-key",
  SSH_AUTH_SOCK: "/fixture/ssh-agent.sock",
};

const macTempDirectory = "/fixture/user-temp/";

const env = {
  HOME: "/fixture/home",
  USER: "terminal-fixture",
  LOGNAME: "terminal-fixture",
  SHELL: "/fixture/bin/zsh",
  TMPDIR: macTempDirectory,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "en_US.UTF-8",
};

function resolve(
  platform: "darwin" | "linux" | "win32",
  systemAccount: typeof account | undefined,
  executable: readonly string[],
  tempDirectory = macTempDirectory,
) {
  return resolveComputerTerminalLaunch({
    platform,
    readAccount: () => systemAccount,
    macTempDirectory: tempDirectory,
    isExecutable: (path: string) => executable.includes(path),
  });
}

test("builds exactly the terminal environment even inside a poisoned daemon process", async () => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `import { resolveComputerTerminalLaunch } from "#src/platform/computer-terminal-launch";
      const result = resolveComputerTerminalLaunch({
        platform: "darwin",
        readAccount: () => (${JSON.stringify(account)}),
        isExecutable: () => true,
        macTempDirectory: ${JSON.stringify(macTempDirectory)},
      });
      console.log(JSON.stringify(result));`,
    ],
    cwd: import.meta.dir + "/..",
    env: inherited,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({ cwd: "/fixture/home", shell: "/fixture/bin/zsh", env });
});

test("uses platform shell fallbacks with deterministic locale and refuses an unavailable fallback", () => {
  const missingShell = { ...account, shell: "" };
  expect(resolve("darwin", missingShell, ["/bin/zsh"])).toMatchObject({
    cwd: "/fixture/home",
    shell: "/bin/zsh",
    env: { ...env, SHELL: "/bin/zsh" },
  });
  expect(resolve("linux", missingShell, ["/bin/bash", "/bin/sh"])).toMatchObject({
    cwd: "/fixture/home",
    shell: "/bin/bash",
    env: { ...env, SHELL: "/bin/bash", LANG: "C.UTF-8", TMPDIR: "/tmp" },
  });
  expect(resolve("linux", account, ["/bin/sh"])).toMatchObject({
    shell: "/bin/sh",
    env: { ...env, SHELL: "/bin/sh", LANG: "C.UTF-8", TMPDIR: "/tmp" },
  });
  expect(() => resolve("darwin", missingShell, [])).toThrow("spawn_failed");
  expect(() => resolve("darwin", account, [account.shell], "relative-temp")).toThrow(
    "spawn_failed",
  );
  expect(() =>
    resolveComputerTerminalLaunch({
      platform: "darwin",
      readAccount: () => account,
      isExecutable: () => true,
    }),
  ).toThrow("spawn_failed");
});

test("refuses unsupported platforms, unmapped accounts, relative homes and disabled shells", () => {
  expect(() => resolve("win32", account, [account.shell])).toThrow("unsupported");
  expect(() => resolve("darwin", undefined, ["/bin/zsh"])).toThrow("spawn_failed");
  expect(() => resolve("darwin", { ...account, homedir: "relative" }, ["/bin/zsh"])).toThrow(
    "spawn_failed",
  );
  for (const shell of ["/usr/sbin/nologin", "/bin/false"]) {
    expect(() => resolve("linux", { ...account, shell }, ["/bin/bash", shell])).toThrow(
      "permission_denied",
    );
  }
});

if (process.platform === "darwin" || process.platform === "linux") {
  test("resolves the operating system account under a poisoned environment", async () => {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `import { readComputerTerminalAccount, readComputerTerminalTempDirectory } from "#src/platform/computer-terminal-launch";
        const account = await readComputerTerminalAccount();
        const tmp = await readComputerTerminalTempDirectory();
        console.log(JSON.stringify({
          tmp: Boolean(tmp?.startsWith("/") && tmp !== Bun.env.TMPDIR && (process.platform !== "darwin" || tmp !== "/tmp")),
          user: Boolean(account?.username && account.username !== Bun.env.USER),
          home: Boolean(account?.homedir.startsWith("/") && account.homedir !== Bun.env.HOME),
          shell: Boolean(account?.shell !== Bun.env.SHELL),
        }));`,
      ],
      cwd: import.meta.dir + "/..",
      env: inherited,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      child.stdout.text(),
      child.stderr.text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toEqual({ tmp: true, user: true, home: true, shell: true });
  });
}
