import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { workspaceStateDirectory } from "@lrm/coforge-daemon";
import { runCli } from "#src/cli";
import { createLogsCommand } from "#src/cli/daemon-commands";
import { computerLogPath } from "#src/logging/computer-logger";
import { followComputerLogs, readComputerLogs } from "#src/logging/computer-logs";

test("Computer logs fails with an actionable error when no log file exists", async () => {
  const directory = join(tmpdir(), `coforge-computer-logs-${crypto.randomUUID()}`);
  try {
    await expect(
      followComputerLogs({
        dataDirectory: directory,
        write: () => {},
      }),
    ).rejects.toThrow("No Computer log exists");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Computer logs includes records appended while printing the initial active file", async () => {
  const directory = join(tmpdir(), `coforge-computer-logs-${crypto.randomUUID()}`);
  const path = computerLogPath(directory);
  const existing = '{"event":"existing"}';
  const appended = '{"event":"appended during initial output"}';
  const output: string[] = [];
  const controller = new AbortController();
  try {
    await mkdir(join(directory, "logs", "computer"), { recursive: true });
    await Bun.write(path, `${existing}\n`);
    await followComputerLogs({
      dataDirectory: directory,
      write: (line) => {
        output.push(line);
        // Append synchronously at the output boundary, before following can resume.
        if (line === existing) appendFileSync(path, `${appended}\n`);
      },
      signal: controller.signal,
      sleep: async () => controller.abort(),
    });
    expect(output).toEqual([existing, appended]);
  } finally {
    controller.abort();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Computer logs prints rotated files and follows new active records", async () => {
  const directory = join(tmpdir(), `coforge-computer-logs-${crypto.randomUUID()}`);
  const path = computerLogPath(directory);
  const output: string[] = [];
  const controller = new AbortController();
  await mkdir(join(directory, "logs", "computer"), { recursive: true });
  await writeFile(`${path}.1`, '{"@timestamp":"2026-08-28T10:00:00.000Z","event":"rotated"}\n');
  await writeFile(path, '{"@timestamp":"2026-08-28T10:00:01.000Z","event":"existing"}\n');

  let polls = 0;
  const following = followComputerLogs({
    dataDirectory: directory,
    write: (line) => output.push(line),
    signal: controller.signal,
    sleep: async () => {
      if (polls++ === 0)
        await writeFile(
          path,
          '{"@timestamp":"2026-08-28T10:00:01.000Z","event":"existing"}\n{"@timestamp":"2026-08-28T10:00:02.000Z","event":"new"}\n',
        );
      else controller.abort();
    },
  });
  await following;

  expect(output).toEqual([
    '{"@timestamp":"2026-08-28T10:00:00.000Z","event":"rotated"}',
    '{"@timestamp":"2026-08-28T10:00:01.000Z","event":"existing"}',
    '{"@timestamp":"2026-08-28T10:00:02.000Z","event":"new"}',
  ]);
  await rm(directory, { recursive: true, force: true });
});

test("readComputerLogs defaults to a bounded one-shot tail across rotated files without hanging", async () => {
  const directory = join(tmpdir(), `coforge-computer-logs-${crypto.randomUUID()}`);
  const path = computerLogPath(directory);
  const output: string[] = [];
  let slept = false;
  try {
    await mkdir(join(directory, "logs", "computer"), { recursive: true });
    await writeFile(`${path}.2`, "line-1\nline-2\n");
    await writeFile(`${path}.1`, "line-3\nline-4\n");
    await writeFile(path, "line-5\n");

    await readComputerLogs({
      logPath: path,
      lines: 3,
      write: (line) => output.push(line),
      sleep: async () => {
        slept = true;
      },
    });

    expect(slept).toBe(false);
    expect(output).toEqual(["line-3", "line-4", "line-5"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("createLogsCommand selects computer, supervisor, and workspace daemon logs", async () => {
  const root = join(tmpdir(), `coforge-logs-sources-${crypto.randomUUID()}`);
  const computerDir = join(root, "computer");
  const stateDir = join(root, "daemon");
  try {
    const wsDir = workspaceStateDirectory(stateDir, "ws-1");
    await mkdir(join(computerDir, "logs", "computer"), { recursive: true });
    await mkdir(join(stateDir, "logs", "daemon"), { recursive: true });
    await mkdir(join(wsDir, "logs", "daemon"), { recursive: true });
    await writeFile(join(computerDir, "logs", "computer", "computer.jsonl"), "cli-1\ncli-2\n");
    await writeFile(join(stateDir, "logs", "daemon", "daemon.jsonl"), "sup-1\nsup-2\n");
    await writeFile(join(wsDir, "logs", "daemon", "daemon.jsonl"), "ws-a\nws-b\nws-c\n");

    const out: string[] = [];
    const logs = createLogsCommand(
      computerDir,
      { stdout: (line) => out.push(line) },
      {
        stateDirectory: stateDir,
        resolveWorkspace: async (selector) => {
          if (selector === "acme" || selector === "ws-1") return { id: "ws-1", slug: "acme" };
          throw new Error(`Workspace '${selector}' is not registered locally`);
        },
      },
    );

    await logs.run!({ lines: 1 });
    expect(out.splice(0)).toEqual(["cli-2"]);

    await logs.run!({ source: "supervisor", lines: 2 });
    expect(out.splice(0)).toEqual(["sup-1", "sup-2"]);

    await logs.run!({ source: { workspace: "acme" }, lines: 2 });
    expect(out.splice(0)).toEqual(["ws-b", "ws-c"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("logs CLI wires --lines, -f/--follow, --supervisor, and --workspace and rejects invalid flags", async () => {
  const calls: unknown[] = [];
  const stderr: string[] = [];
  const deps = {
    login: { async run() {} },
    setup: { async run() {} },
    logs: {
      async run(options: unknown) {
        calls.push(options);
      },
    },
  };

  expect(await runCli(["logs"], deps)).toBe(0);
  expect(await runCli(["logs", "--supervisor", "--lines", "50"], deps)).toBe(0);
  expect(await runCli(["logs", "--workspace", "acme", "-f", "-n", "25"], deps)).toBe(0);

  expect(calls).toEqual([
    { lines: 200, follow: false, source: "computer" },
    { lines: 50, follow: false, source: "supervisor" },
    { lines: 25, follow: true, source: { workspace: "acme" } },
  ]);

  expect(
    await runCli(["logs", "--supervisor", "--workspace", "acme"], deps, {
      stdout: () => {},
      stderr: (line) => stderr.push(line),
    }),
  ).toBe(1);
  expect(stderr.splice(0).join("\n")).toContain("LOGS_CONFLICTING_SOURCE");

  expect(
    await runCli(["logs", "--lines", "0"], deps, {
      stdout: () => {},
      stderr: (line) => stderr.push(line),
    }),
  ).toBe(1);
  expect(stderr.splice(0).join("\n")).toContain("LOGS_INVALID_LINES");
});
