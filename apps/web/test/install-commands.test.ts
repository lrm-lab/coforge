import { expect, test } from "bun:test";

import { installCommands, setupCommand } from "#src/features/install/install-commands";

/** Both the public landing page and the signed-in Add Computer dialog render from this, so a
 * host baked into either one would send half the users to the wrong deployment. */
test("roots both bootstrap commands at the given deployment", () => {
  const commands = installCommands("https://staging.coforge.cn");

  expect(commands.posix).toBe("curl -fsSL https://staging.coforge.cn/computer/install.sh | sh");
  expect(commands.windows).toBe("irm https://staging.coforge.cn/computer/install.ps1 | iex");
});

test("carries no fixed host of its own", () => {
  const commands = installCommands("http://localhost:8788");

  expect(`${commands.posix} ${commands.windows}`).not.toContain("coforge.cn");
});

/** The two-command install flow's second step: the same shape the Computer CLI's `setup`
 * subcommand accepts, so the command copied out of the dialog just works. */
test("builds the Workspace setup command for a given slug", () => {
  expect(setupCommand("acme-inc")).toBe("coforge-computer setup --workspace acme-inc");
});

test("carries no fixed host, since the setup command runs against whatever server the Computer already logged into", () => {
  expect(setupCommand("acme-inc")).not.toContain("coforge.cn");
  expect(setupCommand("acme-inc")).not.toContain("http");
});

test.each(["absolute", "relative", "unset"])(
  "connects without PATH with %s XDG_BIN_HOME",
  async (kind) => {
    const { connectionCommands } = await import("#src/features/install/install-commands");
    const { mkdtemp, mkdir, chmod, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "coforge-connect-command-"));
    try {
      const bin =
        kind === "absolute" ? join(directory, "custom bin") : join(directory, ".local/bin");
      await mkdir(bin, { recursive: true });
      const executable = join(bin, "coforge-computer");
      await Bun.write(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
      await chmod(executable, 0o755);
      const command = connectionCommands("https://coforge.example", "acme-inc").posix;
      const setup = command.split("\n")[1]!;
      const result = Bun.spawnSync(["/bin/sh", "-c", setup], {
        env: {
          PATH: "/usr/bin:/bin",
          HOME: directory,
          ...(kind === "unset" ? {} : { XDG_BIN_HOME: kind === "absolute" ? bin : "relative" }),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe("setup\n--workspace\nacme-inc\n");
      expect(command.split("\n")[0]).toBe(
        "curl -fsSL https://coforge.example/computer/install.sh | sh",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
