import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildShardSummary, parseSummaryMarkdown, type ShardSummary } from "./web-e2e-summary";

test("parseSummaryMarkdown and buildShardSummary compute exact per-file, ui-sweep, and wall-time totals", () => {
  const markdown = [
    "### Browser e2e shard 1 of 4",
    "",
    "| File | Result | Seconds |",
    "| --- | --- | --- |",
    "| e2e-first-sign-in-name.e2e.ts | pass | 99 |",
    "| e2e-agent-replying.e2e.ts | fail | 62 |",
    "| ui-sweep | pass | 186 |",
    "",
  ].join("\n");

  const parsed = parseSummaryMarkdown(markdown);
  expect(parsed).toEqual({
    headerShard: 1,
    headerShards: 4,
    files: [
      { file: "e2e-first-sign-in-name.e2e.ts", result: "pass", seconds: 99 },
      { file: "e2e-agent-replying.e2e.ts", result: "fail", seconds: 62 },
    ],
    uiSweep: { result: "pass", seconds: 186 },
    abortedAfter: null,
  });

  const summary = buildShardSummary({
    shard: 1,
    shards: 4,
    markdown,
    outcome: "failure",
    e2eFile: "",
    e2eRepeat: 1,
    startedAtEpochSeconds: 1_700_000_000,
    finishedAtEpochSeconds: 1_700_000_432,
    github: { sha: "abc123", runId: "456", runAttempt: "1" },
  });

  expect(summary).toEqual({
    schemaVersion: 1,
    shard: 1,
    shards: 4,
    mode: "full",
    outcome: "failure",
    summaryPresent: true,
    abortedAfter: null,
    files: [
      { file: "e2e-first-sign-in-name.e2e.ts", result: "pass", seconds: 99 },
      { file: "e2e-agent-replying.e2e.ts", result: "fail", seconds: 62 },
    ],
    uiSweep: { result: "pass", seconds: 186 },
    totals: {
      totalFiles: 2,
      passedFiles: 1,
      failedFiles: 1,
      filesSeconds: 161,
      uiSweepSeconds: 186,
      measuredSeconds: 347,
    },
    timing: {
      startedAt: "2023-11-14T22:13:20.000Z",
      finishedAt: "2023-11-14T22:20:32.000Z",
      stepWallSeconds: 432,
      nonTestOverheadSeconds: 85,
    },
    github: { sha: "abc123", runId: "456", runAttempt: "1" },
  });
});

test("CLI summary artifacts across all 4 shards partition the CI list once and align measured seconds", async () => {
  const listText = await Bun.file("scripts/e2e/web-e2e-ci.txt").text();
  const listEntries = listText
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
    .map((line) => {
      const [file, seconds] = line.trim().split(/\s+/);
      return [file!, Number(seconds)] as const;
    });
  const weights = new Map(listEntries);

  const dir = await mkdtemp(join(tmpdir(), "coforge-web-e2e-summary-"));
  try {
    const summaries: ShardSummary[] = [];
    for (let shard = 1; shard <= 4; shard++) {
      const listProc = Bun.spawn(
        ["bash", "scripts/e2e/run-web-e2e-ci.sh", String(shard), "4", "--list"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, listCode] = await Promise.all([
        new Response(listProc.stdout).text(),
        listProc.exited,
      ]);
      expect(listCode, `shard ${shard} --list`).toBe(0);
      const shardFiles = stdout.split("\n").filter(Boolean);
      const rows = shardFiles.map((file) => `| ${file} | pass | ${weights.get(file)!} |`);
      if (shard === 1) rows.push("| ui-sweep | pass | 186 |");

      const mdPath = join(dir, `shard-${shard}-summary.md`);
      const jsonPath = join(dir, `shard-${shard}-summary.json`);
      const startedPath = join(dir, `shard-${shard}.epoch`);
      await Bun.write(
        mdPath,
        [
          `### Browser e2e shard ${shard} of 4`,
          "",
          "| File | Result | Seconds |",
          "| --- | --- | --- |",
          ...rows,
          "",
        ].join("\n"),
      );
      await Bun.write(startedPath, "1700000000\n");

      const expectedMeasured =
        shardFiles.reduce((sum, file) => sum + weights.get(file)!, 0) + (shard === 1 ? 186 : 0);
      const finishedEpoch = 1700000000 + expectedMeasured + 82;

      const cliProc = Bun.spawn(
        [
          "bun",
          "scripts/ci/web-e2e-summary.ts",
          "--input",
          mdPath,
          "--output",
          jsonPath,
          "--shard",
          String(shard),
          "--shards",
          "4",
          "--outcome",
          "success",
          "--started-at-file",
          startedPath,
          "--finished-at",
          String(finishedEpoch),
          "--e2e-file",
          "",
          "--e2e-repeat",
          "1",
          "--sha",
          "deadbeef",
          "--run-id",
          "999",
          "--run-attempt",
          "1",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, cliCode] = await Promise.all([
        new Response(cliProc.stderr).text(),
        cliProc.exited,
      ]);
      expect(cliCode, `shard ${shard} summary CLI: ${stderr}`).toBe(0);

      const parsedJson = (await Bun.file(jsonPath).json()) as ShardSummary;
      expect(parsedJson.parseError).toBeUndefined();
      expect(parsedJson.mode).toBe("full");
      expect(parsedJson.soak).toBeUndefined();
      expect(parsedJson.totals.measuredSeconds).toBe(expectedMeasured);
      expect(parsedJson.totals.filesSeconds + parsedJson.totals.uiSweepSeconds).toBe(
        parsedJson.totals.measuredSeconds,
      );
      expect(
        parsedJson.totals.measuredSeconds + (parsedJson.timing.nonTestOverheadSeconds ?? -1),
      ).toBe(parsedJson.timing.stepWallSeconds!);
      summaries.push(parsedJson);
    }

    const allFiles = summaries.flatMap((summary) => summary.files.map((entry) => entry.file));
    expect(new Set(allFiles).size).toBe(allFiles.length);
    expect([...allFiles].sort()).toEqual(listEntries.map(([file]) => file).sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildShardSummary handles aborts, missing summary.md, single-file soak mode, and rejects malformed input", async () => {
  const aborted = buildShardSummary({
    shard: 2,
    shards: 4,
    markdown: [
      "### Browser e2e shard 2 of 4",
      "",
      "| File | Result | Seconds |",
      "| --- | --- | --- |",
      "| e2e-foo.e2e.ts | fail | 41 |",
      "",
      "The Web or its front door stopped answering after e2e-foo.e2e.ts; later files did not run.",
      "",
    ].join("\n"),
    outcome: "failure",
  });
  expect(aborted.abortedAfter).toBe("e2e-foo.e2e.ts");
  expect(aborted.totals).toEqual({
    totalFiles: 1,
    passedFiles: 0,
    failedFiles: 1,
    filesSeconds: 41,
    uiSweepSeconds: 0,
    measuredSeconds: 41,
  });

  const dir = await mkdtemp(join(tmpdir(), "coforge-web-e2e-missing-"));
  try {
    const missingOutput = join(dir, "nested", "summary.json");
    const proc = Bun.spawn(
      [
        "bun",
        "scripts/ci/web-e2e-summary.ts",
        "--input",
        join(dir, "does-not-exist.md"),
        "--output",
        missingOutput,
        "--shard",
        "1",
        "--shards",
        "4",
        "--outcome",
        "failure",
        "--started-at-file",
        join(dir, "missing.epoch"),
        "--e2e-file",
        "e2e-task-popup-esc.e2e.ts",
        "--e2e-repeat",
        "10",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(await proc.exited).toBe(0);
    const missingSummary = (await Bun.file(missingOutput).json()) as ShardSummary;
    expect(missingSummary.parseError).toBeUndefined();
    expect(missingSummary.summaryPresent).toBe(false);
    expect(missingSummary.mode).toBe("single-file");
    expect(missingSummary.soak).toEqual({ file: "e2e-task-popup-esc.e2e.ts", repeat: 10 });
    expect(missingSummary.totals.measuredSeconds).toBe(0);
    expect(missingSummary.timing).toEqual({
      startedAt: null,
      finishedAt: null,
      stepWallSeconds: null,
      nonTestOverheadSeconds: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  expect(() =>
    buildShardSummary({
      shard: 1,
      shards: 4,
      markdown: "### Browser e2e shard 2 of 4\n",
      outcome: "success",
    }),
  ).toThrow("does not match 1 of 4");

  expect(() =>
    parseSummaryMarkdown("| File | Result | Seconds |\n| --- | --- | --- |\n| bad | skipped | 1 |"),
  ).toThrow("Malformed summary table row");

  expect(() =>
    parseSummaryMarkdown("### Browser e2e shard 1 of 4\n### Browser e2e shard 1 of 4\n"),
  ).toThrow("Duplicate shard summary header");

  expect(() => parseSummaryMarkdown("Extra prose line\n")).toThrow("Unexpected summary line");
});

test("CLI fails open on malformed or drifted summary.md and corrupt epoch files without turning green shards red", async () => {
  const dir = await mkdtemp(join(tmpdir(), "coforge-web-e2e-fail-open-"));
  try {
    const startedPath = join(dir, "started-at.epoch");
    await Bun.write(startedPath, "1700000000\n");

    const unexpectedMd = join(dir, "unexpected.md");
    const unexpectedOut = join(dir, "unexpected.json");
    await Bun.write(
      unexpectedMd,
      [
        "### Browser e2e shard 1 of 4",
        "",
        "| File | Result | Seconds |",
        "| --- | --- | --- |",
        "| e2e-first-sign-in-name.e2e.ts | pass | 99 |",
        "",
        "Added diagnostic line from a future runner",
        "",
      ].join("\n"),
    );

    const runCli = async (args: string[]) => {
      const proc = Bun.spawn(["bun", "scripts/ci/web-e2e-summary.ts", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      return { stderr, code };
    };

    const unexpectedRun = await runCli([
      "--input",
      unexpectedMd,
      "--output",
      unexpectedOut,
      "--shard",
      "1",
      "--shards",
      "4",
      "--outcome",
      "success",
      "--started-at-file",
      startedPath,
      "--finished-at",
      "1700000250",
      "--sha",
      "cafebabe",
      "--run-id",
      "1234",
      "--run-attempt",
      "2",
    ]);
    expect(unexpectedRun.code).toBe(0);
    expect(unexpectedRun.stderr).toContain("Unexpected summary line");

    const unexpectedJson = (await Bun.file(unexpectedOut).json()) as ShardSummary;
    expect(unexpectedJson).toEqual({
      schemaVersion: 1,
      shard: 1,
      shards: 4,
      mode: "full",
      outcome: "success",
      summaryPresent: true,
      parseError: "Unexpected summary line: Added diagnostic line from a future runner",
      abortedAfter: null,
      files: [],
      uiSweep: null,
      totals: {
        totalFiles: 0,
        passedFiles: 0,
        failedFiles: 0,
        filesSeconds: 0,
        uiSweepSeconds: 0,
        measuredSeconds: 0,
      },
      timing: {
        startedAt: "2023-11-14T22:13:20.000Z",
        finishedAt: "2023-11-14T22:17:30.000Z",
        stepWallSeconds: 250,
        nonTestOverheadSeconds: null,
      },
      github: {
        sha: "cafebabe",
        runId: "1234",
        runAttempt: "2",
      },
    });

    const malformedMd = join(dir, "malformed.md");
    const malformedOut = join(dir, "malformed.json");
    await Bun.write(
      malformedMd,
      "| File | Result | Seconds |\n| --- | --- | --- |\n| bad | skipped | 1 |\n",
    );
    const malformedRun = await runCli([
      "--input",
      malformedMd,
      "--output",
      malformedOut,
      "--shard",
      "1",
      "--shards",
      "4",
      "--outcome",
      "failure",
    ]);
    expect(malformedRun.code).toBe(0);
    const malformedJson = (await Bun.file(malformedOut).json()) as ShardSummary;
    expect(malformedJson.summaryPresent).toBe(true);
    expect(malformedJson.parseError).toContain("Malformed summary table row");

    const mismatchMd = join(dir, "mismatch.md");
    const mismatchOut = join(dir, "mismatch.json");
    await Bun.write(mismatchMd, "### Browser e2e shard 2 of 4\n");
    const mismatchRun = await runCli([
      "--input",
      mismatchMd,
      "--output",
      mismatchOut,
      "--shard",
      "1",
      "--shards",
      "4",
      "--outcome",
      "success",
    ]);
    expect(mismatchRun.code).toBe(0);
    const mismatchJson = (await Bun.file(mismatchOut).json()) as ShardSummary;
    expect(mismatchJson.summaryPresent).toBe(true);
    expect(mismatchJson.parseError).toContain("does not match 1 of 4");

    const corruptEpoch = join(dir, "corrupt.epoch");
    const validMd = join(dir, "valid.md");
    const validOut = join(dir, "valid.json");
    await Bun.write(corruptEpoch, "not-a-number\n");
    await Bun.write(
      validMd,
      [
        "### Browser e2e shard 3 of 4",
        "",
        "| File | Result | Seconds |",
        "| --- | --- | --- |",
        "| e2e-first-sign-in-name.e2e.ts | pass | 99 |",
        "",
      ].join("\n"),
    );
    const corruptEpochRun = await runCli([
      "--input",
      validMd,
      "--output",
      validOut,
      "--shard",
      "3",
      "--shards",
      "4",
      "--outcome",
      "success",
      "--started-at-file",
      corruptEpoch,
      "--e2e-repeat",
      "not-a-number",
    ]);
    expect(corruptEpochRun.code).toBe(0);
    const validJson = (await Bun.file(validOut).json()) as ShardSummary;
    expect(validJson.parseError).toBeUndefined();
    expect(validJson.summaryPresent).toBe(true);
    expect(validJson.files).toEqual([
      { file: "e2e-first-sign-in-name.e2e.ts", result: "pass", seconds: 99 },
    ]);
    expect(validJson.timing).toEqual({
      startedAt: null,
      finishedAt: null,
      stepWallSeconds: null,
      nonTestOverheadSeconds: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
