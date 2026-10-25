import { stat } from "node:fs/promises";
import {
  UsageUnavailableError,
  UsageUnsupportedError,
  type UsageOfficialBucket,
  type UsageSnapshot,
  type UsageWindow,
  cleanupOwnedTree,
} from "@lrm/coforge-anvil";
import { withDeadline } from "#src/code-agent/deadline";
import { maskEmail } from "#src/code-agent/mask-email";

import { ProcessTreeOwner } from "#src/platform/process-tree";
import type { OwnedChildProcess } from "@lrm/coforge-anvil";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { runClaudeCli } from "./process";

export class ClaudeUsageTimeoutError extends Error {
  constructor() {
    super("Claude Code usage request timed out");
  }
}

/** The installed Claude Code lacks the structured usage protocol; only then may the caller read
 * the human `/usage` text instead. */
export class ClaudeStructuredUsageUnsupportedError extends Error {
  constructor() {
    super("Claude Code does not support structured usage");
  }
}

const SESSION_MINUTES = 300;
const WEEK_MINUTES = 10_080;
const MAX_LINE_CHARS = 4_000_000;
const STRUCTURED_FLAGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--no-session-persistence",
  "--safe-mode",
];

type Json = Record<string, unknown>;
const capabilityCache = new Map<string, boolean>();

/** Whether `claude --help` lists `--safe-mode`, which the structured protocol needs. Cached per
 * command, resolved executable path and build (mtime and size), so an upgrade is noticed. A help
 * run that exits non-zero says nothing about the capability: it is `UsageUnavailableError`. */
export async function supportsStructuredUsage(
  command: readonly string[],
  cwd: string,
  environment: Record<string, string>,
  timeoutMs: number,
): Promise<boolean> {
  const executable = command[0]
    ? Bun.which(command[0], { cwd, PATH: environment.PATH ?? "" })
    : null;
  const build = executable ? await stat(executable).catch(() => undefined) : undefined;
  const key = build
    ? `${command.join("\0")}\0${executable}\0${build.mtimeMs}\0${build.size}`
    : undefined;
  const cached = key ? capabilityCache.get(key) : undefined;
  if (cached !== undefined) return cached;
  const help = await runClaudeCli([...command, "--help"], cwd, environment, timeoutMs);
  if (help.timedOut) throw new ClaudeUsageTimeoutError();
  if (help.exitCode !== 0) throw new UsageUnavailableError();
  const supported = help.stdout.includes("--safe-mode");
  if (key) capabilityCache.set(key, supported);
  return supported;
}

/**
 * Reads usage through Claude Code's stream-json control protocol: `initialize` for the account,
 * then `get_usage`. Returns null when not signed in. Throws `ClaudeStructuredUsageUnsupportedError`
 * only when the CLI reports the subtype as unknown; every other failure is a typed usage error.
 * The whole exchange is bounded by `timeoutMs` and the child's process tree is always cleaned up.
 */
export async function readStructuredUsage(
  command: readonly string[],
  cwd: string,
  environment: Record<string, string>,
  timeoutMs: number,
): Promise<UsageSnapshot | null> {
  const tree = new ProcessTreeOwner().spawn([...command, ...STRUCTURED_FLAGS], cwd, environment);
  let snapshot: UsageSnapshot | null;
  try {
    snapshot = await withDeadline(
      exchange(tree.child),
      timeoutMs,
      () => new ClaudeUsageTimeoutError(),
    );
  } catch (error) {
    await cleanupOwnedTree(tree, tree.child).catch(() => {});
    throw error;
  }
  await cleanupOwnedTree(tree, tree.child);
  return snapshot;
}

async function exchange(child: OwnedChildProcess): Promise<UsageSnapshot | null> {
  void (async () => {
    for await (const _ of child.stderr) void _;
  })().catch(() => {});
  const nextLine = lineReader(child.stdout);
  const send = async (request: Json): Promise<Json> => {
    const requestId = crypto.randomUUID();
    try {
      child.stdin.write(
        `${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`,
      );
      await (child.stdin as { flush(): Promise<void> }).flush();
    } catch {
      throw new UsageUnavailableError();
    }
    for (;;) {
      const line = await nextLine();
      if (line === undefined) throw new UsageUnavailableError();
      const message = parseObject(line);
      const response = object(message?.response);
      if (message?.type !== "control_response" || response?.request_id !== requestId) continue;
      return response;
    }
  };

  const init = await send({ subtype: "initialize" });
  if (init.subtype === "error") {
    if (notSignedIn(init.error)) return null;
    throw new UsageUnavailableError();
  }
  const initBody = object(init.response);
  if (init.subtype !== "success" || !initBody) throw new UsageUnavailableError();
  const account = object(initBody.account);
  if (!account || !(nonEmpty(account.email) || nonEmpty(account.subscriptionType))) return null;

  const usage = await send({ subtype: "get_usage", skip_behaviors: true });
  if (usage.subtype === "error") {
    const message = typeof usage.error === "string" ? usage.error : "";
    if (
      /(unknown|unsupported|unrecognized)[^.]*subtype|subtype[^.]*(unknown|unsupported)/i.test(
        message,
      )
    )
      throw new ClaudeStructuredUsageUnsupportedError();
    if (notSignedIn(usage.error)) return null;
    throw new UsageUnavailableError();
  }
  const body = object(usage.response);
  if (usage.subtype !== "success" || !body) throw new UsageUnavailableError();
  return toSnapshot(body, account);
}

function toSnapshot(body: Json, account: Json): UsageSnapshot {
  const planType = nonEmpty(body.subscription_type) ?? nonEmpty(account.subscriptionType);
  const accountLabel = typeof account.email === "string" ? maskEmail(account.email) : undefined;
  if (body.rate_limits_available === false) throw new UsageUnsupportedError();
  if (body.rate_limits_available !== true) throw new UsageUnavailableError();
  const limits = object(body.rate_limits);
  if (!limits) throw new UsageUnavailableError();

  const session = bucket(limits.five_hour, "Current session", SESSION_MINUTES);
  const week = bucket(limits.seven_day, "Current week (all models)", WEEK_MINUTES);
  const buckets: UsageOfficialBucket[] = [];
  if (session) buckets.push(session);
  if (week) buckets.push(week);
  // Optional buckets are best effort: a malformed one is skipped, never fatal.
  const scoped = limits.model_scoped ?? body.model_scoped;
  for (const item of Array.isArray(scoped) ? scoped : []) {
    const entry = object(item);
    const name = nonEmpty(entry?.display_name);
    const scopedBucket = name ? optionalBucket(entry, `Current week (${name})`) : undefined;
    if (scopedBucket && !buckets.some((existing) => existing.name === scopedBucket.name))
      buckets.push(scopedBucket);
  }
  for (const [key, label] of OTHER_WEEKLY) {
    const other = optionalBucket(limits[key], label);
    if (other && !buckets.some((existing) => existing.name === label)) buckets.push(other);
  }
  if (buckets.length === 0) throw new UsageUnavailableError();
  return {
    provider: RUNTIME_PROVIDER.CLAUDE_CODE,
    ...(planType ? { planType } : {}),
    ...(accountLabel ? { accountLabel } : {}),
    ...(session ? { primary: windowOf(session) } : {}),
    ...(week ? { secondary: windowOf(week) } : {}),
    officialGroups: [{ buckets }],
  };
}

const OTHER_WEEKLY: readonly (readonly [string, string])[] = [
  ["seven_day_opus", "Current week (Opus)"],
  ["seven_day_sonnet", "Current week (Sonnet)"],
  ["seven_day_oauth_apps", "Current week (OAuth apps)"],
  ["seven_day_cowork", "Current week (Cowork)"],
];

/** One quota bucket from `{utilization, resets_at}`; null or absent means no such limit. The
 * window length is the real one (the 5-hour session, the 7-day week), not the time left. */
function bucket(
  value: unknown,
  name: string,
  windowDurationMinutes: number,
): UsageOfficialBucket | undefined {
  if (value === null || value === undefined) return undefined;
  const entry = object(value);
  const percent = entry?.utilization;
  if (!entry || typeof percent !== "number" || !Number.isFinite(percent) || percent < 0)
    throw new UsageUnavailableError();
  const reset = typeof entry.resets_at === "string" ? Date.parse(entry.resets_at) : Number.NaN;
  return {
    name,
    usedPercent: percent,
    status: percent >= 100 ? "limit_reached" : "ok",
    windowDurationMinutes,
    ...(Number.isNaN(reset) ? {} : { resetsAt: new Date(reset).toISOString() }),
  };
}

function optionalBucket(value: unknown, name: string): UsageOfficialBucket | undefined {
  try {
    return bucket(value, name, WEEK_MINUTES);
  } catch {
    return undefined;
  }
}

function windowOf(source: UsageOfficialBucket): UsageWindow {
  return {
    usedPercent: source.usedPercent,
    windowDurationMinutes: source.windowDurationMinutes ?? 0,
    ...(source.resetsAt ? { resetsAt: source.resetsAt } : {}),
  };
}

function lineReader(stream: AsyncIterable<Uint8Array>): () => Promise<string | undefined> {
  const iterator = stream[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  let buffer = "";
  return async () => {
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        return line;
      }
      if (buffer.length > MAX_LINE_CHARS) throw new UsageUnavailableError();
      const chunk = await iterator.next();
      if (chunk.done) {
        const rest = buffer.trim();
        buffer = "";
        return rest || undefined;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
}

function notSignedIn(error: unknown): boolean {
  return (
    typeof error === "string" &&
    /not (?:logged|signed) in|please (?:log|sign) in|\/login|invalid api key|\b401\b|unauthorized/i.test(
      error,
    )
  );
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function object(value: unknown): Json | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

function parseObject(line: string): Json | undefined {
  try {
    return object(JSON.parse(line));
  } catch {
    return undefined;
  }
}
