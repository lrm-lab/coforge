import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNNER_HOLD_REASONS } from "@lrm/coforge-sdk/internal";
import {
  COMPUTER_TERMINAL_CAPABILITY,
  type ComputerTerminalControl,
} from "@lrm/coforge-sdk/internal/computer-terminal-wire";
import { ComputerTerminalSession } from "#src/daemon-runtime/computer-terminal-session";
import { InMemoryDaemonCredentialStore } from "#src/credentials/credential-store";
import { DaemonRuntime } from "#src/daemon-runtime/runtime";
import { emptyCodeAgentDiscovery } from "./fixtures/code-agent-discovery";
import { spawnComputerTerminalPty } from "#src/platform/computer-terminal-pty";
import { isPidAlive } from "#src/platform/process-liveness";

const testEnvironment = { PATH: "/usr/bin:/bin", TERM: "xterm-256color" };

if (process.platform === "darwin" || process.platform === "linux") {
  test("uses a real PTY for binary input, resize and the shell exit status", async () => {
    const ready = Promise.withResolvers<void>();
    let output = "";
    const pty = spawnComputerTerminalPty({
      command: [
        process.execPath,
        "--no-env-file",
        "-e",
        `process.stdin.setRawMode(true);
          process.stdin.once("data", (bytes) => {
            console.log(JSON.stringify([process.stdout.columns, process.stdout.rows, ...bytes]));
            process.exit(7);
          });
          console.log("READY");`,
      ],
      cwd: "/tmp",
      environment: testEnvironment,
      cols: 80,
      rows: 24,
      onOutput(bytes) {
        output += new TextDecoder().decode(bytes);
        if (output.includes("READY")) ready.resolve();
      },
    });
    try {
      await pty.ready;
      await Promise.race([
        ready.promise,
        pty.shellExited.then(() => {
          throw new Error("PTY exited before becoming ready");
        }),
      ]);
      pty.resize(104, 37);
      await pty.write(Uint8Array.of(0, 4, 255));
      expect(await pty.shellExited).toEqual({ code: 7, signal: null });
      await pty.close();
      expect(output).toContain("[104,37,0,4,255]");
    } finally {
      await pty.close();
    }
  }, 10_000);

  test("bounds a stalled PTY write and releases its caller when closing", async () => {
    const ready = Promise.withResolvers<void>();
    const pty = spawnComputerTerminalPty({
      command: [
        process.execPath,
        "--no-env-file",
        "-e",
        'process.stdin.setRawMode(true); console.log("READY"); await Bun.sleep(20_000);',
      ],
      cwd: "/tmp",
      environment: testEnvironment,
      cols: 80,
      rows: 24,
      onOutput(bytes) {
        if (new TextDecoder().decode(bytes).includes("READY")) ready.resolve();
      },
    });
    try {
      await pty.ready;
      await ready.promise;
      const first = pty.write(new Uint8Array(16 * 1024)).then(
        () => "written",
        () => "closed",
      );
      await expect(pty.write(Uint8Array.of(4))).rejects.toThrow("backpressured");
      await pty.close();
      expect(await first).toBe("closed");
    } finally {
      await pty.close();
    }
  }, 10_000);

  test.each(["computer_stop", "computer_upgrade"] as const)(
    "cleans an orphan in a separate job group during %s",
    async (shutdownReason) => {
      const background = Promise.withResolvers<number>();
      let output = "";
      const workspaceRoot = await mkdtemp(join(await realpath(tmpdir()), "terminal-stop-"));
      const connection = { workspaceId: "workspace", computerId: "computer", workspaceRoot };
      const credentials = new InMemoryDaemonCredentialStore();
      await credentials.save(connection.workspaceId, connection.computerId, "fake-terminal-token");
      const outside = Bun.spawn(["/bin/sleep", "20"], { env: testEnvironment, detached: true });
      const pty = spawnComputerTerminalPty({
        command: [
          "/bin/bash",
          "-c",
          'set -m; /bin/sleep 20 </dev/null >/dev/null 2>&1 & job=$!; disown "$job"; printf \'OWNED %d\\n\' "$job"; exit 0',
        ],
        cwd: "/tmp",
        environment: testEnvironment,
        cols: 80,
        rows: 24,
        onOutput(bytes) {
          output += new TextDecoder().decode(bytes);
          const pid = /OWNED (\d+)/.exec(output)?.[1];
          if (pid) background.resolve(Number(pid));
        },
      });
      const notices: string[] = [];
      const capabilities: string[] = [];
      const opened = Promise.withResolvers<void>();
      let control: ((frame: ComputerTerminalControl) => Promise<void>) | undefined;
      let owned: number | undefined;
      const runtime = new DaemonRuntime(
        connection,
        () => {
          throw new Error("No Agent expected");
        },
        credentials,
        {
          create: () => ({
            async start() {},
            async stop() {},
            async ready(request) {
              capabilities.push(...(request().capabilities ?? []));
            },
            onComputerTerminalControl(listener) {
              control = listener;
              return () => {
                control = undefined;
              };
            },
            async sendComputerTerminalFrame(frame) {
              if (frame.event.case === "opened") opened.resolve();
            },
            async sendShutdownNotice({ reason }) {
              expect(owned).toBeDefined();
              expect(await isPidAlive(owned!)).toBe(false);
              notices.push(reason);
            },
          }),
        },
        undefined,
        emptyCodeAgentDiscovery,
        workspaceRoot,
        {
          createComputerTerminal: (binding) =>
            new ComputerTerminalSession({
              ...binding,
              async spawn() {
                const shellExited = Promise.withResolvers<{
                  code: number;
                  signal: string | null;
                }>();
                return {
                  ...pty,
                  shellKind: "bash",
                  shellExited: shellExited.promise,
                  async close() {
                    await pty.close();
                    shellExited.resolve({ code: 0, signal: null });
                  },
                };
              },
            }),
        },
      );
      try {
        await runtime.start(connection);
        expect(capabilities).toContain(COMPUTER_TERMINAL_CAPABILITY);
        expect(control).toBeDefined();
        await control!({
          protocolMajor: 1,
          workspaceId: connection.workspaceId,
          computerId: connection.computerId,
          ownerUserId: "owner",
          sessionId: "session",
          attachId: "attach",
          attachGeneration: 1,
          command: { case: "openOrAttach", value: { cols: 80, rows: 24, takeover: false } },
        });
        await opened.promise;
        owned = await background.promise;
        expect(await pty.shellExited).toEqual({ code: 0, signal: null });
        expect(await isPidAlive(owned)).toBe(true);
        if (shutdownReason === "computer_upgrade")
          runtime.holdRunners(RUNNER_HOLD_REASONS.COMPUTER_UPGRADE);
        await runtime.stop();
        expect(notices).toEqual([shutdownReason]);
        expect(await isPidAlive(owned)).toBe(false);
        expect(outside.exitCode).toBeNull();
      } finally {
        outside.kill("SIGKILL");
        await outside.exited;
        await pty.close();
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    },
    10_000,
  );
}
