// Derives a compact machine-readable per-shard JSON summary from `$E2E_OUTPUT/summary.md`
// so green and near-green `web-e2e.yml` runs expose exact per-file timings without uploading
// heavy logs or screenshots.
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type ShardTestResult = "pass" | "fail";

export type ShardFileEntry = {
  file: string;
  result: ShardTestResult;
  seconds: number;
};

export type UiSweepSummary = {
  result: ShardTestResult;
  seconds: number;
};

export type ParsedSummaryMarkdown = {
  headerShard: number | null;
  headerShards: number | null;
  files: ShardFileEntry[];
  uiSweep: UiSweepSummary | null;
  abortedAfter: string | null;
};

export type ShardSummary = {
  schemaVersion: 1;
  shard: number;
  shards: number;
  mode: "full" | "single-file";
  soak?: {
    file: string;
    repeat: number;
  };
  outcome: string | null;
  summaryPresent: boolean;
  parseError?: string;
  abortedAfter: string | null;
  files: ShardFileEntry[];
  uiSweep: UiSweepSummary | null;
  totals: {
    totalFiles: number;
    passedFiles: number;
    failedFiles: number;
    filesSeconds: number;
    uiSweepSeconds: number;
    measuredSeconds: number;
  };
  timing: {
    startedAt: string | null;
    finishedAt: string | null;
    stepWallSeconds: number | null;
    nonTestOverheadSeconds: number | null;
  };
  github: {
    sha: string | null;
    runId: string | null;
    runAttempt: string | null;
  };
};

export type BuildShardSummaryOptions = {
  shard: number;
  shards: number;
  markdown: string | null;
  outcome: string | null;
  e2eFile?: string;
  e2eRepeat?: number | null;
  startedAtEpochSeconds?: number | null;
  finishedAtEpochSeconds?: number | null;
  github?: {
    sha?: string;
    runId?: string;
    runAttempt?: string;
  };
};

export type BuildShardSummaryFallbackOptions = Omit<BuildShardSummaryOptions, "markdown"> & {
  summaryPresent: boolean;
  parseError: string;
};

const HEADER_RE = /^### Browser e2e shard (\d+) of (\d+)$/;
const TABLE_HEADER_RE = /^\|\s*File\s*\|\s*Result\s*\|\s*Seconds\s*\|$/;
const TABLE_DIVIDER_RE = /^\|\s*---+\s*\|\s*---+\s*\|\s*---+\s*\|$/;
const TABLE_ROW_RE = /^\|\s*([^|]+?)\s*\|\s*(pass|fail)\s*\|\s*(\d+)\s*\|$/;
const ABORT_RE =
  /^The Web or its front door stopped answering after (.+?); later files did not run\.$/;

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer (got ${String(value)})`);
  }
  return value;
}

/** Parses the Markdown table and metadata written by `scripts/e2e/run-web-e2e-ci.sh`. */
export function parseSummaryMarkdown(markdown: string): ParsedSummaryMarkdown {
  let headerShard: number | null = null;
  let headerShards: number | null = null;
  const files: ShardFileEntry[] = [];
  let uiSweep: UiSweepSummary | null = null;
  let abortedAfter: string | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const headerMatch = HEADER_RE.exec(line);
    if (headerMatch) {
      if (headerShard !== null || headerShards !== null) {
        throw new Error(`Duplicate shard summary header: ${line}`);
      }
      headerShard = Number(headerMatch[1]);
      headerShards = Number(headerMatch[2]);
      continue;
    }

    const abortMatch = ABORT_RE.exec(line);
    if (abortMatch) {
      abortedAfter = abortMatch[1]!.trim();
      continue;
    }

    if (line.startsWith("|")) {
      if (TABLE_HEADER_RE.test(line) || TABLE_DIVIDER_RE.test(line)) continue;
      const rowMatch = TABLE_ROW_RE.exec(line);
      if (!rowMatch) {
        throw new Error(`Malformed summary table row: ${line}`);
      }
      const name = rowMatch[1]!.trim();
      const result = rowMatch[2] as ShardTestResult;
      const seconds = Number(rowMatch[3]);
      if (!Number.isSafeInteger(seconds) || seconds < 0) {
        throw new Error(`Invalid seconds in summary row: ${line}`);
      }
      if (name === "ui-sweep") {
        if (uiSweep !== null) {
          throw new Error(`Duplicate ui-sweep row in summary: ${line}`);
        }
        uiSweep = { result, seconds };
      } else {
        files.push({ file: name, result, seconds });
      }
      continue;
    }

    throw new Error(`Unexpected summary line: ${line}`);
  }

  return { headerShard, headerShards, files, uiSweep, abortedAfter };
}

function isValidEpochSeconds(value: number | null | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value * 1000) <= 8_640_000_000_000_000
  );
}

function buildSummaryTiming(
  startedAtEpochSeconds: number | null | undefined,
  finishedAtEpochSeconds: number | null | undefined,
  measuredSeconds: number | null,
): ShardSummary["timing"] {
  const hasTiming =
    startedAtEpochSeconds !== undefined &&
    startedAtEpochSeconds !== null &&
    finishedAtEpochSeconds !== undefined &&
    finishedAtEpochSeconds !== null;

  if (!hasTiming) {
    return {
      startedAt: null,
      finishedAt: null,
      stepWallSeconds: null,
      nonTestOverheadSeconds: null,
    };
  }

  if (!isValidEpochSeconds(startedAtEpochSeconds) || !isValidEpochSeconds(finishedAtEpochSeconds)) {
    throw new Error("Timing epoch seconds must be finite numbers");
  }

  const stepWallSeconds = Math.max(0, finishedAtEpochSeconds - startedAtEpochSeconds);
  return {
    startedAt: new Date(startedAtEpochSeconds * 1000).toISOString(),
    finishedAt: new Date(finishedAtEpochSeconds * 1000).toISOString(),
    stepWallSeconds,
    nonTestOverheadSeconds:
      measuredSeconds === null ? null : Math.max(0, stepWallSeconds - measuredSeconds),
  };
}

function buildSummaryEnvelope(
  options: Omit<BuildShardSummaryOptions, "markdown">,
  fields: {
    summaryPresent: boolean;
    parseError?: string;
    abortedAfter: string | null;
    files: ShardFileEntry[];
    uiSweep: UiSweepSummary | null;
    totals: ShardSummary["totals"];
    timing: ShardSummary["timing"];
    soakRepeat: number;
  },
): ShardSummary {
  const normalizedFile = options.e2eFile?.trim() ?? "";
  const mode = normalizedFile ? "single-file" : "full";
  return {
    schemaVersion: 1,
    shard: options.shard,
    shards: options.shards,
    mode,
    ...(mode === "single-file"
      ? { soak: { file: normalizedFile, repeat: fields.soakRepeat } }
      : {}),
    outcome: options.outcome?.trim() || null,
    summaryPresent: fields.summaryPresent,
    ...(fields.parseError !== undefined ? { parseError: fields.parseError } : {}),
    abortedAfter: fields.abortedAfter,
    files: fields.files,
    uiSweep: fields.uiSweep,
    totals: fields.totals,
    timing: fields.timing,
    github: {
      sha: options.github?.sha?.trim() || null,
      runId: options.github?.runId?.trim() || null,
      runAttempt: options.github?.runAttempt?.trim() || null,
    },
  };
}

/** Builds a validated per-shard JSON summary from step metadata and optional `summary.md`. */
export function buildShardSummary(options: BuildShardSummaryOptions): ShardSummary {
  const shard = assertPositiveInteger(options.shard, "shard");
  const shards = assertPositiveInteger(options.shards, "shards");
  if (shard > shards) {
    throw new Error(`shard (${shard}) cannot exceed shards (${shards})`);
  }

  const summaryPresent = options.markdown !== null;
  const parsed: ParsedSummaryMarkdown =
    options.markdown !== null
      ? parseSummaryMarkdown(options.markdown)
      : { headerShard: null, headerShards: null, files: [], uiSweep: null, abortedAfter: null };

  if (
    parsed.headerShard !== null &&
    parsed.headerShards !== null &&
    (parsed.headerShard !== shard || parsed.headerShards !== shards)
  ) {
    throw new Error(
      `Summary header shard ${parsed.headerShard} of ${parsed.headerShards} does not match ${shard} of ${shards}`,
    );
  }

  const soakRepeat =
    options.e2eRepeat !== undefined && options.e2eRepeat !== null
      ? assertPositiveInteger(options.e2eRepeat, "e2eRepeat")
      : 1;

  const passedFiles = parsed.files.filter((entry) => entry.result === "pass").length;
  const failedFiles = parsed.files.filter((entry) => entry.result === "fail").length;
  const filesSeconds = parsed.files.reduce((sum, entry) => sum + entry.seconds, 0);
  const uiSweepSeconds = parsed.uiSweep?.seconds ?? 0;
  const measuredSeconds = filesSeconds + uiSweepSeconds;

  return buildSummaryEnvelope(options, {
    summaryPresent,
    abortedAfter: parsed.abortedAfter,
    files: parsed.files,
    uiSweep: parsed.uiSweep,
    totals: {
      totalFiles: parsed.files.length,
      passedFiles,
      failedFiles,
      filesSeconds,
      uiSweepSeconds,
      measuredSeconds,
    },
    timing: buildSummaryTiming(
      options.startedAtEpochSeconds,
      options.finishedAtEpochSeconds,
      measuredSeconds,
    ),
    soakRepeat,
  });
}

/** Builds a fail-open forensic summary when reading or parsing `summary.md` fails. */
export function buildShardSummaryFallback(options: BuildShardSummaryFallbackOptions): ShardSummary {
  const soakRepeat =
    typeof options.e2eRepeat === "number" &&
    Number.isInteger(options.e2eRepeat) &&
    options.e2eRepeat >= 1
      ? options.e2eRepeat
      : 1;
  const hasSafeTiming =
    isValidEpochSeconds(options.startedAtEpochSeconds) &&
    isValidEpochSeconds(options.finishedAtEpochSeconds);

  return buildSummaryEnvelope(options, {
    summaryPresent: options.summaryPresent,
    parseError: options.parseError,
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
    timing: buildSummaryTiming(
      hasSafeTiming ? options.startedAtEpochSeconds : null,
      hasSafeTiming ? options.finishedAtEpochSeconds : null,
      null,
    ),
    soakRepeat,
  });
}

type CliArgs = {
  input?: string;
  output: string;
  shard: number;
  shards: number;
  outcome: string | null;
  startedAtFile?: string;
  finishedAt?: number;
  e2eFile?: string;
  e2eRepeat?: number | null;
  sha?: string;
  runId?: string;
  runAttempt?: string;
};

function parseIntegerFlag(value: string, flag: string): number {
  if (!/^-?\d+$/.test(value.trim())) {
    throw new Error(`${flag} must be an integer (got ${JSON.stringify(value)})`);
  }
  return Number(value.trim());
}

function parseCliArgs(argv: string[]): CliArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (!flag.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${flag}`);
    }
    if (i + 1 >= argv.length) {
      throw new Error(`Missing value for ${flag}`);
    }
    values.set(flag, argv[++i]!);
  }

  const output = values.get("--output")?.trim();
  const shardRaw = values.get("--shard")?.trim();
  const shardsRaw = values.get("--shards")?.trim();
  if (!output) throw new Error("--output is required");
  if (!shardRaw) throw new Error("--shard is required");
  if (!shardsRaw) throw new Error("--shards is required");

  const finishedRaw = values.get("--finished-at")?.trim();
  const repeatRaw = values.get("--e2e-repeat")?.trim();

  return {
    input: values.get("--input")?.trim() || undefined,
    output,
    shard: parseIntegerFlag(shardRaw, "--shard"),
    shards: parseIntegerFlag(shardsRaw, "--shards"),
    outcome: values.get("--outcome")?.trim() || null,
    startedAtFile: values.get("--started-at-file")?.trim() || undefined,
    finishedAt: finishedRaw ? parseIntegerFlag(finishedRaw, "--finished-at") : undefined,
    e2eFile: values.get("--e2e-file"),
    e2eRepeat: repeatRaw && /^[1-9]\d*$/.test(repeatRaw) ? Number(repeatRaw) : null,
    sha: values.get("--sha"),
    runId: values.get("--run-id"),
    runAttempt: values.get("--run-attempt"),
  };
}

if (import.meta.main) {
  const args = parseCliArgs(process.argv.slice(2));
  let summaryPresent = false;
  let markdown: string | null = null;
  let readError: string | null = null;
  if (args.input) {
    try {
      const inputFile = Bun.file(args.input);
      if (await inputFile.exists()) {
        summaryPresent = true;
        markdown = await inputFile.text();
      }
    } catch (error) {
      readError = error instanceof Error ? error.message : String(error);
    }
  }

  let startedAtEpochSeconds: number | null = null;
  if (args.startedAtFile) {
    try {
      const startedFile = Bun.file(args.startedAtFile);
      if (await startedFile.exists()) {
        const raw = (await startedFile.text()).trim();
        if (/^\d+$/.test(raw)) {
          const parsedEpoch = Number(raw);
          if (isValidEpochSeconds(parsedEpoch)) {
            startedAtEpochSeconds = parsedEpoch;
          }
        }
      }
    } catch {
      startedAtEpochSeconds = null;
    }
  }

  const finishedAtEpochSeconds =
    args.finishedAt ?? (startedAtEpochSeconds !== null ? Math.floor(Date.now() / 1000) : null);

  const common = {
    shard: args.shard,
    shards: args.shards,
    outcome: args.outcome,
    e2eFile: args.e2eFile,
    e2eRepeat: args.e2eRepeat,
    startedAtEpochSeconds,
    finishedAtEpochSeconds,
    github: {
      sha: args.sha,
      runId: args.runId,
      runAttempt: args.runAttempt,
    },
  };

  let summary: ShardSummary;
  if (readError !== null) {
    console.warn(`web-e2e-summary: ${readError}`);
    summary = buildShardSummaryFallback({
      ...common,
      summaryPresent,
      parseError: readError,
    });
  } else {
    try {
      summary = buildShardSummary({
        ...common,
        markdown,
      });
    } catch (error) {
      const parseError = error instanceof Error ? error.message : String(error);
      console.warn(`web-e2e-summary: ${parseError}`);
      summary = buildShardSummaryFallback({
        ...common,
        summaryPresent,
        parseError,
      });
    }
  }

  await mkdir(dirname(args.output), { recursive: true });
  await Bun.write(args.output, `${JSON.stringify(summary, null, 2)}\n`);
}
