export type ArtifactCheckConfig = {
  workerUrl: string;
  secret: string;
  concurrency: number;
  timeoutMs: number;
  dailyCap: number;
};

const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 45_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_DAILY_CAP = 200;
const MAX_DAILY_CAP = 10_000;

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseDailyCap(raw: string | undefined): number {
  if (!raw) return DEFAULT_DAILY_CAP;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DAILY_CAP;
  return Math.min(MAX_DAILY_CAP, parsed);
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "127.0.0.1" || lower === "localhost" || lower === "[::1]" || lower === "::1";
}

export function artifactCheckConfig(
  env: Record<string, string | undefined> = process.env,
): ArtifactCheckConfig | null {
  const rawUrl = env.COFORGE_ARTIFACT_CHECK_WORKER_URL?.trim();
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const secret = env.COFORGE_ARTIFACT_CHECK_SECRET?.trim() ?? "";
  if (!secret && !isLoopbackHost(parsed.hostname)) return null;
  return {
    workerUrl: parsed.toString().replace(/\/+$/, ""),
    secret,
    concurrency: parseBoundedInt(
      env.COFORGE_ARTIFACT_CHECK_CONCURRENCY,
      DEFAULT_CONCURRENCY,
      1,
      MAX_CONCURRENCY,
    ),
    timeoutMs: parseBoundedInt(
      env.COFORGE_ARTIFACT_CHECK_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    dailyCap: parseDailyCap(env.COFORGE_ARTIFACT_CHECK_DAILY_CAP),
  };
}

export function artifactChecksEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return artifactCheckConfig(env) !== null;
}
