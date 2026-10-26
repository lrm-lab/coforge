import { expect, test } from "bun:test";
import { bootClockMs, parseProcStat } from "#src/platform/linux-process-table";

test("a /proc stat line is read after the command's last parenthesis", () => {
  // Fields 3.. after the command: state ppid pgrp session tty tpgid flags minflt cminflt majflt
  // cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime ...
  const rest = "S 7 11 13 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 2000";
  expect(parseProcStat(`4242 (bun) ${rest}`)).toEqual({ ppid: 7, pgid: 11, startTicks: 987654 });
  // A command with spaces and parentheses must not shift the fields.
  expect(parseProcStat(`4242 (a) b (c) ${rest}`)).toEqual({
    ppid: 7,
    pgid: 11,
    startTicks: 987654,
  });
});

test("a /proc stat line that is cut short is not a process", () => {
  expect(parseProcStat("4242 (bun) S 7 11")).toBeUndefined();
  expect(parseProcStat("")).toBeUndefined();
});

test.skipIf(process.platform !== "linux")(
  "the boot clock counts up like /proc/uptime",
  async () => {
    const first = bootClockMs();
    await Bun.sleep(30);
    const second = bootClockMs();
    expect(second).toBeGreaterThan(first);
    expect(second - first).toBeLessThan(5_000);
  },
);
