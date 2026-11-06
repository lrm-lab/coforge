import type { UsageOfficialBucket, UsageOfficialGroup, UsageSnapshot } from "#src/contract";
import { UsageReauthRequiredError, UsageUnavailableError } from "#src/contract";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import type { DroidAuthProcess } from "./auth";
import { VtScreen } from "./vt-screen";

/** Droid's `/limits` panel only lays out its percentages at a wide terminal: at the transport's
 * 120-column default it collapses to bar glyphs with no readable numbers, so the usage scan
 * spawns its own larger screen. Verified on droid 1.5.0. */
export const DROID_USAGE_SCREEN = { cols: 160, rows: 40 } as const;

/** The interactive TUI plus three panel captures and process cleanup take well past a usage
 * scan's shared default; the runtime declares this longer budget, still inside the caller's
 * wait, like Kiro's own floor. */
export const DROID_USAGE_TIMEOUT_MS = 45_000;

const PANEL_SETTLE_QUIET_MS = 500;
const PANEL_SETTLE_DEADLINE_MS = 4_000;
const TAB_SETTLE_QUIET_MS = 500;
const TAB_SETTLE_DEADLINE_MS = 2_500;
const MAX_POOL_CAPTURES = 5;

/** The host spawns the interactive `droid` TUI in a PTY for one usage read. */
export interface DroidUsageHost {
  spawn(workingDirectory: string): DroidAuthProcess;
  /** One stable reason code per failed scan, for the daemon log — never screen contents. */
  logFailure?(reason: string): void;
}

/** A failed scan carries the stage that rejected it so the host log can name it; it still reads
 * as the ordinary "usage unavailable" outcome to every caller. */
class DroidUsageScanError extends UsageUnavailableError {
  constructor(readonly reason: string) {
    super();
    this.name = "DroidUsageScanError";
  }
}

const POOLS = [
  { key: "standard", label: "Standard", tab: "Standard" },
  { key: "droidCore", label: "Droid Core", tab: "Droid Core" },
  { key: "extraUsage", label: "Extra Usage", tab: "Extra Usage" },
] as const;
type PoolKey = (typeof POOLS)[number]["key"];

const WINDOWS = [
  { key: "5h", label: "5-hour", minutes: 300 },
  { key: "weekly", label: "Weekly", minutes: 10_080 },
  { key: "monthly", label: "Monthly", minutes: 43_200 },
] as const;

/** Reads the account's plan usage by driving the interactive TUI's `/limits` panel. ACP's
 * `usage_update` reports only the context window, so the panel is the only verified source. */
export async function readDroidUsage(
  options: Readonly<{ workingDirectory: string; timeoutMs?: number }>,
  host: DroidUsageHost,
): Promise<UsageSnapshot> {
  const deadline = Date.now() + Math.max(options.timeoutMs ?? 0, DROID_USAGE_TIMEOUT_MS);
  let process: DroidAuthProcess;
  try {
    process = host.spawn(options.workingDirectory);
  } catch {
    host.logFailure?.("spawn_failed");
    throw new UsageUnavailableError();
  }
  const screen = new VtScreen(DROID_USAGE_SCREEN);
  const decoder = new TextDecoder();
  let lastOutputAt = Date.now();
  let exited = false;
  const pump = (async () => {
    try {
      for await (const chunk of process.output) {
        screen.write(decoder.decode(chunk, { stream: true }));
        lastOutputAt = Date.now();
      }
    } finally {
      exited = true;
    }
  })();
  void pump.catch(() => {});
  void process.exited.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );

  const fail = (reason: string): never => {
    throw new DroidUsageScanError(reason);
  };
  const lines = () => screen.lines();
  const text = () => lines().join("\n");
  const remaining = () => deadline - Date.now();
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const checkDeadline = () => {
    if (remaining() <= 0) fail("timeout");
    if (exited) fail("process_exited");
    const body = text();
    if (/trust this (folder|directory)|do you trust/i.test(body)) fail("trust_prompt");
    if (/sign in|log in to (factory|get started)/i.test(body) && !/Usage & Limits/.test(body))
      throw new UsageReauthRequiredError();
  };
  const waitFor = async (predicate: () => boolean, maxMs: number): Promise<boolean> => {
    const until = Math.min(Date.now() + maxMs, deadline);
    while (Date.now() < until) {
      checkDeadline();
      if (predicate()) return true;
      await sleep(50);
    }
    checkDeadline();
    return predicate();
  };
  const waitQuiet = async (quietMs: number, maxMs: number) => {
    const until = Math.min(Date.now() + maxMs, deadline);
    while (Date.now() < until) {
      checkDeadline();
      if (Date.now() - lastOutputAt >= quietMs) return;
      await sleep(50);
    }
    checkDeadline();
  };
  const selectedPool = () => selectedPoolOf(lines());

  try {
    // The TUI draws its first screen asynchronously; wait for output, then a quiet beat so the
    // `/limits` keystrokes land after the input loop is reading, not in the tty buffer.
    await waitFor(() => text().trim().length > 0, remaining());
    await waitQuiet(PANEL_SETTLE_QUIET_MS, PANEL_SETTLE_DEADLINE_MS);
    process.write("/limits\r");
    const panelUp = await waitFor(() => text().includes("Usage & Limits"), remaining());
    if (!panelUp) fail("panel_not_found");
    await waitQuiet(PANEL_SETTLE_QUIET_MS, PANEL_SETTLE_DEADLINE_MS);

    // Capture the selected pool, then Tab through the rest until the selection cycles back —
    // the tab bar's pool order is the only ordering the panel offers.
    const screens: string[][] = [];
    for (let capture = 0; capture < MAX_POOL_CAPTURES; capture += 1) {
      screens.push(lines());
      const pool = selectedPool();
      if (capture > 0 && pool !== undefined && pool === selectedPoolOf(screens[0]!)) break;
      if (capture === MAX_POOL_CAPTURES - 1) break;
      process.write("\t");
      const before = selectedPool();
      await waitFor(
        () => selectedPool() !== before || selectedPool() === undefined,
        TAB_SETTLE_DEADLINE_MS,
      );
      await waitQuiet(TAB_SETTLE_QUIET_MS, TAB_SETTLE_DEADLINE_MS);
    }
    try {
      process.write("\x1b");
      await Promise.race([process.exited, sleep(400)]);
    } catch {
      // Closing the panel is best-effort; dispose below owns the tree either way.
    }
    return parseDroidLimitsScreens(screens, Date.now());
  } catch (error) {
    if (error instanceof UsageReauthRequiredError) {
      host.logFailure?.("reauth_required");
      throw error;
    }
    if (error instanceof DroidUsageScanError) {
      host.logFailure?.(error.reason);
      throw error;
    }
    if (error instanceof UsageUnavailableError) throw error;
    host.logFailure?.("unexpected");
    throw new UsageUnavailableError();
  } finally {
    await process.dispose();
    await pump.catch(() => {});
  }
}

/** The pool whose tab marker is `◉` on this screen; undefined when the tab bar is unreadable or
 * no pool is selected. A plan may offer fewer than all three pools, so presence is per-name. */
function selectedPoolOf(lines: readonly string[]): PoolKey | undefined {
  const tabLine = lines.find(
    (line) => /[◉○]/.test(line) && POOLS.filter((pool) => line.includes(pool.tab)).length >= 2,
  );
  if (!tabLine) return undefined;
  for (const pool of POOLS) {
    if (!tabLine.includes(pool.tab)) continue;
    const marker = new RegExp(`([◉○])\\s*${pool.tab}`).exec(tabLine);
    if (marker?.[1] === "◉") return pool.key;
  }
  return undefined;
}

/** Parses one captured screen into its official group; throws `DroidUsageScanError` naming the
 * rejected stage so a malformed panel never becomes partial or invented numbers. */
function parsePoolScreen(
  lines: readonly string[],
  key: PoolKey,
  nowMs: number,
): UsageOfficialGroup {
  const panelTop = lines.findIndex((line) => line.includes("Usage & Limits"));
  if (panelTop < 0) throw new DroidUsageScanError("panel_header_missing");
  const name = POOLS.find((pool) => pool.key === key)!.label;
  if (key === "extraUsage") return parseExtraUsageScreen(lines, panelTop, name);
  const buckets: UsageOfficialBucket[] = [];
  for (const window of WINDOWS) {
    const row = lines
      .slice(panelTop)
      .find((line) => new RegExp(`\\b${window.label}\\s+\\d`).test(line));
    if (!row) throw new DroidUsageScanError(`window_missing:${window.label}`);
    const match = new RegExp(`\\b${window.label}\\s+(\\d{1,3}(?:\\.\\d+)?)\\s*%`).exec(row);
    if (!match) throw new DroidUsageScanError(`window_unparsed:${window.label}`);
    const usedPercent = Number(match[1]);
    if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100)
      throw new DroidUsageScanError(`window_percent:${window.label}`);
    const after = row.slice(match.index + match[0].length);
    const resetMatch = /↻\s*([^│]+)/.exec(after);
    const unused = /Use Droid to start/.test(after);
    const resetsAt = resetMatch ? parseDroidResetDuration(resetMatch[1]!, nowMs) : undefined;
    buckets.push({
      id: `droid-${key}-${window.key}`,
      name: window.label,
      window: window.key,
      usedPercent,
      status: usedPercent >= 100 ? "limit_reached" : "ok",
      windowDurationMinutes: window.minutes,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
      ...(unused ? { description: "Not started" } : {}),
    });
  }
  return { name, buckets };
}

/** The Extra Usage tab reports a prepaid dollar balance, not a window: `$X.XX remaining` under
 * its `Balance` row, or a known empty state. The "When limit is reached" footer repeats a
 * `($0.00 remaining)` hint, so only the region between `Balance` and that footer counts —
 * anything unreadable there is refused rather than rendered as zero. */
function parseExtraUsageScreen(
  lines: readonly string[],
  panelTop: number,
  name: string,
): UsageOfficialGroup {
  const balanceIdx = lines.findIndex((line, index) => index > panelTop && /\bBalance\b/.test(line));
  const regionStart = balanceIdx >= 0 ? balanceIdx : panelTop;
  const footerIdx = lines.findIndex(
    (line, index) => index > regionStart && /When limit is reached/.test(line),
  );
  const region = lines.slice(regionStart, footerIdx >= 0 ? footerIdx : lines.length).join("\n");
  const amount = /\$\s*(\d[\d,]*(?:\.\d{1,2})?)\s+remaining/.exec(region);
  const empty = /(No Extra Usage balance|Low balance[^│\n]*)/i.exec(region);
  if (!amount && !empty) throw new DroidUsageScanError("balance_unparsed");
  const description = (amount ? `$${amount[1]} remaining` : empty![0]).trim();
  return {
    name,
    buckets: [{ id: `droid-extraUsage-balance`, name: "Balance", description }],
  };
}

/** `↻ 2h 32min`, `↻ 5 days`, `↻ 45min`: relative text at minute precision, resolved against the
 * capture instant. An unrecognized phrasing leaves `resetsAt` absent — the daemon's own backoff
 * covers a window whose reset we cannot read. */
function parseDroidResetDuration(text: string, nowMs: number): string | undefined {
  const clean = text.replace(/[│\s]+$/u, "").trim();
  let totalMs = 0;
  let matched = false;
  const add = (pattern: RegExp, ms: number) => {
    const match = pattern.exec(clean);
    if (match) {
      totalMs += Number(match[1]) * ms;
      matched = true;
    }
  };
  add(/(\d+)\s*days?\b/iu, 86_400_000);
  add(/(\d+)\s*h(?:ours?|rs?)?\b/iu, 3_600_000);
  add(/(\d+)\s*min(?:utes?)?\b/iu, 60_000);
  add(/(\d+)\s*s(?:ec(?:onds?)?)?\b/iu, 1_000);
  if (!matched || totalMs <= 0) return undefined;
  return new Date(nowMs + totalMs).toISOString();
}

/** Every captured pool screen becomes one official group; the panel's own "You are using …"
 * note names the active pool, whose 5-hour and weekly windows stay the two-window summary. */
export function parseDroidLimitsScreens(
  screens: readonly (readonly string[])[],
  nowMs: number,
): UsageSnapshot {
  const groups: UsageOfficialGroup[] = [];
  const byKey = new Map<PoolKey, UsageOfficialGroup>();
  for (const screen of screens) {
    const key = selectedPoolOf(screen);
    if (key === undefined || byKey.has(key)) continue;
    const group = parsePoolScreen(screen, key, nowMs);
    byKey.set(key, group);
    groups.push(group);
  }
  if (groups.length === 0) throw new DroidUsageScanError("no_pool_screens");

  const description = screens
    .flat()
    .map((line) => /You are using[^╰─│]+/u.exec(line)?.[0]?.trim())
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const activeKey = description
    ? POOLS.find((pool) => description.includes(pool.tab))?.key
    : selectedPoolOf(screens[0]!);
  const active = activeKey !== undefined ? byKey.get(activeKey) : undefined;

  const summaryWindow = (windowKey: "5h" | "weekly") => {
    const bucket = active?.buckets.find((entry) => entry.window === windowKey);
    if (bucket?.usedPercent === undefined) return undefined;
    return {
      id: bucket.id,
      usedPercent: bucket.usedPercent,
      status: bucket.status,
      windowDurationMinutes: bucket.windowDurationMinutes ?? 0,
      ...(bucket.resetsAt !== undefined ? { resetsAt: bucket.resetsAt } : {}),
    };
  };
  const primary = summaryWindow("5h");
  const secondary = summaryWindow("weekly");

  const limited = groups.some((group) =>
    group.buckets.some((bucket) => bucket.status === "limit_reached"),
  );
  return {
    provider: RUNTIME_PROVIDER.DROID,
    ...(description !== undefined ? { officialDescription: description } : {}),
    officialGroups: groups,
    ...(primary !== undefined ? { primary } : {}),
    ...(secondary !== undefined ? { secondary } : {}),
    health: limited ? "rate_limited" : "ok",
  };
}
