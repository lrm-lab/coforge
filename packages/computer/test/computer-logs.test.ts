import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computerLogPath } from "#src/logging/computer-logger";
import { followComputerLogs } from "#src/logging/computer-logs";

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
