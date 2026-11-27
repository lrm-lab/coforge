import { withDeadline } from "@lrm/coforge-anvil";
import { basename } from "node:path";
import {
  readComputerTerminalAccount,
  readComputerTerminalTempDirectory,
  resolveComputerTerminalLaunch,
} from "#src/platform/computer-terminal-launch";
import { spawnComputerTerminalPty } from "#src/platform/computer-terminal-pty";
import { ComputerTerminalSession } from "./computer-terminal-session";

const TERMINAL_START_WAIT_MS = 3_000;

type ComputerTerminalBinding = Omit<
  ConstructorParameters<typeof ComputerTerminalSession>[0],
  "spawn"
>;

export function createComputerTerminalSession(binding: ComputerTerminalBinding) {
  return new ComputerTerminalSession({
    ...binding,
    async spawn({ cols, rows }, onOutput) {
      const [account, tempDirectory] = await Promise.all([
        readComputerTerminalAccount(),
        readComputerTerminalTempDirectory(),
      ]);
      const { cwd, shell, env } = resolveComputerTerminalLaunch({
        platform: process.platform,
        readAccount: () => account,
        macTempDirectory: tempDirectory,
      });
      const pty = spawnComputerTerminalPty({
        command: [shell],
        cwd,
        environment: env,
        cols,
        rows,
        onOutput,
      });
      try {
        await withDeadline(
          pty.ready,
          TERMINAL_START_WAIT_MS,
          () => new Error("Terminal PTY startup timed out"),
        );
      } catch (error) {
        await pty.close();
        throw error;
      }
      return {
        ...pty,
        shellKind: basename(shell)
          .replace(/[^a-zA-Z0-9_-]/g, "_")
          .slice(0, 128),
      };
    },
  });
}
