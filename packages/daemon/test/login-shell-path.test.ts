import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as fsPromises from "node:fs/promises";
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  LOGIN_SHELL_PATH_SWITCH,
  parsePathEntries,
  quote,
  probeLoginShellPath,
  type LoginShellPathProbeOptions,
} from "#src/platform/login-shell-path";

const roots: string[] = [];
function newRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "coforge-login-shell-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = path.join(import.meta.dir, "fixtures", "print-path-probe.ts");
const realPrinter = [process.execPath, fixture];

/** The probe fixture, copied where no package.json resolves `#src`, so it imports by file path. */
function writeProbeCopy(directory: string): string {
  const copy = path.join(directory, "print-path-probe.ts");
  const module = path.join(import.meta.dir, "..", "src", "platform", "login-shell-path.ts");
  writeFileSync(
    copy,
    `import { writeLoginShellPathProbe } from ${JSON.stringify(module)};\nawait writeLoginShellPathProbe(Bun.argv[3] ?? "", Bun.argv[4] ?? "");\n`,
  );
  return copy;
}

/** A shell named `name` that behaves like `<shell> -i -l -c <script>` with `rc` as its rc file. */
function fakeShell(root: string, name: string, rc: string): string {
  const shell = path.join(root, name);
  writeFileSync(shell, `#!/bin/sh\n${rc}\nexec /bin/sh -c "$4"\n`, { mode: 0o755 });
  chmodSync(shell, 0o755);
  return shell;
}

function probe(root: string, shell: string, extra: LoginShellPathProbeOptions = {}) {
  const tempRoot = path.join(root, "tmp");
  mkdirSync(tempRoot, { recursive: true });
  return probeLoginShellPath({
    platform: "linux",
    environment: { PATH: "/usr/bin:/bin", HOME: root },
    accountShell: () => shell,
    selfCommand: realPrinter,
    tempRoot,
    ...extra,
  });
}

const leftovers = (root: string) => readdirSync(path.join(root, "tmp"));

describe("probeLoginShellPath", () => {
  test("takes PATH from the login shell, ignores rc output, keeps absolute unique entries", async () => {
    const root = newRoot();
    const shell = fakeShell(
      root,
      "zsh",
      [
        `echo '{"nonce":"guess","path":"/evil/from/stdout"}'`,
        `echo "PATH=/evil/other" >&2`,
        `export PATH=/opt/one:relative/dir:/opt/two:/opt/one:$PATH`,
      ].join("\n"),
    );
    const result = await probe(root, shell);
    expect(result).toMatchObject({ ok: true, shell });
    if (!result.ok) throw new Error("unreachable");
    expect(result.path.slice(0, 4)).toEqual(["/opt/one", "/opt/two", "/usr/bin", "/bin"]);
    expect(result.path).not.toContain("relative/dir");
    expect(result.path).not.toContain("/evil/from/stdout");
    expect(new Set(result.path).size).toBe(result.path.length);
    expect(leftovers(root)).toEqual([]);
  });

  test("survives spaces and quotes in the self-executable path", async () => {
    const root = newRoot();
    const odd = path.join(root, "it's a dir");
    mkdirSync(odd);
    const copy = writeProbeCopy(odd);
    const shell = fakeShell(root, "bash", "export PATH=/opt/odd:$PATH");
    const result = await probe(root, shell, { selfCommand: [process.execPath, copy] });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.path[0]).toBe("/opt/odd");
  });

  test("rejects a result file whose nonce does not match", async () => {
    const root = newRoot();
    const forger = path.join(root, "forger");
    writeFileSync(forger, `#!/bin/sh\nprintf '{"nonce":"wrong","path":"/evil"}' > "$2"\n`, {
      mode: 0o755,
    });
    const result = await probe(root, fakeShell(root, "bash", ""), { selfCommand: [forger] });
    expect(result).toMatchObject({ ok: false, reason: "invalid_result" });
    expect(leftovers(root)).toEqual([]);
  });

  test("reports no_result when the command never wrote, and exit_nonzero when the shell failed", async () => {
    const root = newRoot();
    const idle = path.join(root, "idle");
    writeFileSync(idle, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(await probe(root, fakeShell(root, "bash", ""), { selfCommand: [idle] })).toMatchObject({
      ok: false,
      reason: "no_result",
    });
    const failing = path.join(root, "failing");
    writeFileSync(failing, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    expect(await probe(root, fakeShell(root, "zsh", ""), { selfCommand: [failing] })).toMatchObject(
      {
        ok: false,
        reason: "exit_nonzero",
      },
    );
  });

  test("a timeout kills the whole process group, grandchildren included", async () => {
    const root = newRoot();
    const pidFile = path.join(root, "grandchild.pid");
    const shell = path.join(root, "zsh");
    writeFileSync(shell, `#!/bin/sh\nsleep 60 &\necho $! > '${pidFile}'\nwait\n`, { mode: 0o755 });
    const result = await probe(root, shell, { timeoutMs: 2_500 });
    expect(result).toMatchObject({ ok: false, reason: "timeout", shell });
    const grandchild = Number((await Bun.file(pidFile).text()).trim());
    expect(grandchild).toBeGreaterThan(1);
    const deadline = Date.now() + 3_000;
    const alive = () => {
      try {
        process.kill(grandchild, 0);
        return true;
      } catch {
        return false;
      }
    };
    while (alive() && Date.now() < deadline) await Bun.sleep(25);
    expect(alive()).toBe(false);
    expect(leftovers(root)).toEqual([]);
  });

  test("an abort kills the probe and reports aborted", async () => {
    const root = newRoot();
    const shell = path.join(root, "bash");
    writeFileSync(shell, "#!/bin/sh\nsleep 60\n", { mode: 0o755 });
    const controller = new AbortController();
    const pending = probe(root, shell, { signal: controller.signal });
    await Bun.sleep(100);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, reason: "aborted" });
  });

  test("an unsupported shell is refused without spawning; $SHELL is used only without an account shell", async () => {
    const root = newRoot();
    let spawned = 0;
    const spawn: LoginShellPathProbeOptions["spawn"] = () => {
      spawned += 1;
      throw new Error("must not spawn");
    };
    expect(await probe(root, "/usr/bin/nu", { spawn })).toMatchObject({
      ok: false,
      reason: "unsupported_shell",
      shell: "/usr/bin/nu",
    });
    expect(
      await probe(root, "", {
        accountShell: () => undefined,
        environment: { SHELL: "/usr/bin/xonsh" },
        spawn,
      }),
    ).toMatchObject({ ok: false, reason: "unsupported_shell", shell: "/usr/bin/xonsh" });
    expect(
      await probe(root, "", { accountShell: () => undefined, environment: {}, spawn }),
    ).toMatchObject({ ok: false, reason: "unsupported_shell" });
    expect(spawned).toBe(0);
  });

  test("falls back to $SHELL when the account shell is unknown", async () => {
    const root = newRoot();
    const shell = fakeShell(root, "dash", "export PATH=/opt/env-shell:$PATH");
    const result = await probe(root, "", {
      accountShell: () => undefined,
      environment: { SHELL: shell, PATH: "/usr/bin" },
    });
    expect(result).toMatchObject({ ok: true, shell });
  });

  test("COFORGE_LOGIN_SHELL_PATH=0 disables the probe and Windows skips it", async () => {
    const root = newRoot();
    const spawn: LoginShellPathProbeOptions["spawn"] = () => {
      throw new Error("must not spawn");
    };
    const shell = fakeShell(root, "zsh", "");
    expect(
      await probe(root, shell, { spawn, environment: { [LOGIN_SHELL_PATH_SWITCH]: "0" } }),
    ).toMatchObject({ ok: false, reason: "disabled" });
    expect(await probe(root, shell, { spawn, platform: "win32" })).toMatchObject({
      ok: false,
      reason: "skipped",
    });
  });

  test("a shell that cannot be started is spawn_failed", async () => {
    const root = newRoot();
    expect(await probe(root, path.join(root, "missing", "zsh"))).toMatchObject({
      ok: false,
      reason: "spawn_failed",
    });
    expect(leftovers(root)).toEqual([]);
  });

  test("an injected clock measures the duration", async () => {
    const root = newRoot();
    let tick = 0;
    const result = await probe(root, fakeShell(root, "zsh", ""), { now: () => (tick += 5) });
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.durationMs % 5).toBe(0);
  });
});

const fish = Bun.which("fish");
describe.skipIf(!fish)("with a real fish", () => {
  test("reads PATH set in config.fish, through quoting that fish understands", async () => {
    const root = newRoot();
    const config = path.join(root, "xdg", "fish");
    mkdirSync(config, { recursive: true });
    writeFileSync(
      path.join(config, "config.fish"),
      `echo noise from fish config\nfish_add_path --path /fish/added/bin\nset -gx PATH /fish/direct $PATH\n`,
    );
    const odd = path.join(root, "it's a dir");
    mkdirSync(odd);
    const copy = writeProbeCopy(odd);
    const result = await probeLoginShellPath({
      platform: process.platform,
      environment: {
        PATH: process.env.PATH,
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, "xdg"),
      },
      accountShell: () => fish!,
      selfCommand: [process.execPath, copy],
      tempRoot: root,
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.path).toContain("/fish/direct");
  });
});

test("a result file that cannot be created is temp_dir_failed, and the directory is removed", async () => {
  const root = newRoot();
  const failing = spyOn(fsPromises, "writeFile").mockRejectedValueOnce(new Error("EACCES"));
  try {
    const result = await probe(root, fakeShell(root, "zsh", ""));
    expect(result).toMatchObject({ ok: false, reason: "temp_dir_failed" });
  } finally {
    failing.mockRestore();
  }
  expect(leftovers(root)).toEqual([]);
});

describe("quote", () => {
  test("fish escapes backslash and quote inside single quotes", () => {
    expect(quote("fish", "a'b\\c")).toBe("'a\\'b\\\\c'");
  });
  test("POSIX shells close, escape, and reopen the quote", () => {
    expect(quote("bash", "a'b")).toBe("'a'\\''b'");
    expect(quote("zsh", "plain")).toBe("'plain'");
  });
});

describe("parsePathEntries", () => {
  test("keeps absolute directories once, in order", () => {
    expect(parsePathEntries("/a::b:/c:/a:./d:/e\n:/f")).toEqual(["/a", "/c", "/f"]);
  });
});
