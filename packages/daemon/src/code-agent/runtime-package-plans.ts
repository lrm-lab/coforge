import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  RUNTIME_PROVIDER,
  redactCredentials,
  thrownMessage,
  truncateCodePointsWithEllipsis,
  type RuntimeManageReason,
  type RuntimeManageSource,
} from "@lrm/coforge-sdk/internal";
import { codeAgentExecutableSearchPath } from "#src/platform/code-agent-path";

export type RuntimePackageStep = {
  command: string[];
  display: string;
};

export type RuntimePackagePlan =
  | { kind: "plan"; source: RuntimeManageSource; steps: RuntimePackageStep[] }
  | { kind: "unsupported"; reason: RuntimeManageReason };

export type RuntimePackagePlanDeps = {
  platform?: NodeJS.Platform;
  which?: (binary: string) => string | undefined;
  resolveRealPath?: (path: string) => Promise<string | undefined>;
};

export type RuntimePackageStepRunResult =
  | { ok: true }
  | { ok: false; exitCode?: number; diagnostic?: string; timedOut?: boolean; cancelled?: boolean };

const MAX_OUTPUT_BYTES = 256 * 1024;
const DIAGNOSTIC_MAX_CHARS = 400;

const MANAGED_PROVIDERS = new Set<string>([
  RUNTIME_PROVIDER.CLAUDE_CODE,
  RUNTIME_PROVIDER.CODEX,
  RUNTIME_PROVIDER.OPENCODE,
]);

const STRIPPED_ENV_PREFIXES = ["COFORGE_", "SLOCK_"] as const;
const STRIPPED_ENV_EXACT = new Set<string>([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SSE_PORT",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
]);

const URL_CREDENTIALS_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s@]+@/g;

export function isManagedRuntimeProvider(provider: string): boolean {
  return MANAGED_PROVIDERS.has(provider);
}

function createDefaultWhich(
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
  platform: NodeJS.Platform = process.platform,
): (binary: string) => string | undefined {
  const searchPath = codeAgentExecutableSearchPath(environment, platform);
  return (binary: string) => Bun.which(binary, { PATH: searchPath }) ?? undefined;
}

async function defaultResolveRealPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function normalizePathSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}

function isHomebrewPackagePath(path: string): boolean {
  const normalized = normalizePathSlashes(path).toLowerCase();
  return normalized.includes("/cellar/") || normalized.includes("/caskroom/");
}

function isNpmPath(path: string): boolean {
  const normalized = normalizePathSlashes(path).toLowerCase();
  return (
    normalized.includes("/node_modules/") ||
    normalized.includes("/.nvm/") ||
    normalized.includes("/.volta/") ||
    normalized.includes("/.fnm/") ||
    normalized.includes("/.pnpm") ||
    normalized.includes("/.npm")
  );
}

function isMacosAppBundlePath(path: string): boolean {
  const normalized = normalizePathSlashes(path);
  return (
    normalized.includes("ChatGPT.app/Contents/Resources/") ||
    normalized.includes("Codex.app/Contents/Resources/") ||
    normalized.includes("Claude Code.app/Contents/") ||
    normalized.includes("Claude Code URL Handler.app/Contents/")
  );
}

function isClaudeNativeInstallPath(path: string): boolean {
  const normalized = normalizePathSlashes(path).toLowerCase();
  return (
    normalized.includes("/.local/bin/") ||
    normalized.includes("/.local/share/claude/") ||
    normalized.includes("/.claude/local/")
  );
}

function isOpencodeStandalonePath(path: string): boolean {
  const normalized = normalizePathSlashes(path).toLowerCase();
  return normalized.includes("/.opencode/bin/");
}

function npmStep(npmBin: string, pkgSpec: string): RuntimePackageStep {
  return {
    command: [npmBin, "install", "-g", pkgSpec],
    display: `npm install -g ${pkgSpec}`,
  };
}

function brewStep(
  brewBin: string,
  subcommand: "install" | "upgrade",
  target: string,
  cask: boolean,
): RuntimePackageStep {
  const args = cask ? [subcommand, "--cask", target] : [subcommand, target];
  return {
    command: [brewBin, ...args],
    display: `brew ${args.join(" ")}`,
  };
}

export async function resolveRuntimeInstallPlan(
  provider: string,
  deps: RuntimePackagePlanDeps = {},
): Promise<RuntimePackagePlan> {
  if (!isManagedRuntimeProvider(provider)) {
    return { kind: "unsupported", reason: "unsupported_provider" };
  }
  const platform = deps.platform ?? process.platform;
  const which = deps.which ?? createDefaultWhich(Bun.env, platform);
  const npmBin = which("npm");
  const brewBin = platform === "darwin" || platform === "linux" ? which("brew") : undefined;

  if (provider === RUNTIME_PROVIDER.CLAUDE_CODE) {
    if (npmBin) {
      return { kind: "plan", source: "npm", steps: [npmStep(npmBin, "@anthropic-ai/claude-code")] };
    }
    if (platform === "darwin" && brewBin) {
      return {
        kind: "plan",
        source: "homebrew",
        steps: [brewStep(brewBin, "install", RUNTIME_PROVIDER.CLAUDE_CODE, true)],
      };
    }
    return { kind: "unsupported", reason: "missing_package_manager" };
  }

  if (provider === RUNTIME_PROVIDER.CODEX) {
    if (npmBin) {
      return { kind: "plan", source: "npm", steps: [npmStep(npmBin, "@openai/codex")] };
    }
    if (platform === "darwin" && brewBin) {
      return {
        kind: "plan",
        source: "homebrew",
        steps: [brewStep(brewBin, "install", RUNTIME_PROVIDER.CODEX, true)],
      };
    }
    return { kind: "unsupported", reason: "missing_package_manager" };
  }

  if (provider === RUNTIME_PROVIDER.OPENCODE) {
    if (npmBin) {
      return { kind: "plan", source: "npm", steps: [npmStep(npmBin, "opencode-ai")] };
    }
    if (brewBin) {
      return {
        kind: "plan",
        source: "homebrew",
        steps: [brewStep(brewBin, "install", "anomalyco/tap/opencode", false)],
      };
    }
    return { kind: "unsupported", reason: "missing_package_manager" };
  }

  return { kind: "unsupported", reason: "unsupported_provider" };
}

export async function resolveRuntimeUpgradePlan(
  provider: string,
  executablePath: string,
  deps: RuntimePackagePlanDeps = {},
): Promise<RuntimePackagePlan> {
  if (!isManagedRuntimeProvider(provider)) {
    return { kind: "unsupported", reason: "unsupported_provider" };
  }
  if (!executablePath || executablePath.includes("\0") || !isAbsolute(executablePath)) {
    return { kind: "unsupported", reason: "unsupported_installation" };
  }
  const platform = deps.platform ?? process.platform;
  const which = deps.which ?? createDefaultWhich(Bun.env, platform);
  const resolveReal = deps.resolveRealPath ?? defaultResolveRealPath;
  const realPath = (await resolveReal(executablePath)) ?? executablePath;
  const paths = [executablePath, realPath];

  if (paths.some(isMacosAppBundlePath)) {
    return { kind: "unsupported", reason: "managed_by_app_bundle" };
  }

  const npmBin = which("npm");
  const brewBin = platform === "darwin" || platform === "linux" ? which("brew") : undefined;

  if (provider === RUNTIME_PROVIDER.CODEX) {
    if (paths.some(isNpmPath)) {
      return npmBin
        ? { kind: "plan", source: "npm", steps: [npmStep(npmBin, "@openai/codex@latest")] }
        : { kind: "unsupported", reason: "missing_package_manager" };
    }
    if (platform === "darwin" && paths.some(isHomebrewPackagePath)) {
      return brewBin
        ? {
            kind: "plan",
            source: "homebrew",
            steps: [brewStep(brewBin, "upgrade", RUNTIME_PROVIDER.CODEX, true)],
          }
        : { kind: "unsupported", reason: "missing_package_manager" };
    }
    return { kind: "unsupported", reason: "unsupported_installation" };
  }

  if (provider === RUNTIME_PROVIDER.CLAUDE_CODE) {
    if (paths.some(isNpmPath)) {
      return npmBin
        ? {
            kind: "plan",
            source: "npm",
            steps: [npmStep(npmBin, "@anthropic-ai/claude-code@latest")],
          }
        : { kind: "unsupported", reason: "missing_package_manager" };
    }
    if (platform === "darwin" && paths.some(isHomebrewPackagePath)) {
      return brewBin
        ? {
            kind: "plan",
            source: "homebrew",
            steps: [brewStep(brewBin, "upgrade", RUNTIME_PROVIDER.CLAUDE_CODE, true)],
          }
        : { kind: "unsupported", reason: "missing_package_manager" };
    }
    if (paths.some(isClaudeNativeInstallPath)) {
      return {
        kind: "plan",
        source: "native",
        steps: [{ command: [executablePath, "update"], display: "claude update" }],
      };
    }
    return { kind: "unsupported", reason: "unsupported_installation" };
  }

  if (provider === RUNTIME_PROVIDER.OPENCODE) {
    if (paths.some(isNpmPath)) {
      return npmBin
        ? { kind: "plan", source: "npm", steps: [npmStep(npmBin, "opencode-ai@latest")] }
        : { kind: "unsupported", reason: "missing_package_manager" };
    }
    if (paths.some(isHomebrewPackagePath)) {
      return brewBin
        ? {
            kind: "plan",
            source: "homebrew",
            steps: [brewStep(brewBin, "upgrade", "anomalyco/tap/opencode", false)],
          }
        : { kind: "unsupported", reason: "missing_package_manager" };
    }
    if (paths.some(isOpencodeStandalonePath)) {
      return {
        kind: "plan",
        source: "native",
        steps: [{ command: [executablePath, "upgrade"], display: "opencode upgrade" }],
      };
    }
    return { kind: "unsupported", reason: "unsupported_installation" };
  }

  return { kind: "unsupported", reason: "unsupported_provider" };
}

export function sanitizeRuntimeManageEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper === "PATH") continue;
    if (STRIPPED_ENV_EXACT.has(upper)) continue;
    if (STRIPPED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) continue;
    result[key] = value;
  }
  const searchPath = codeAgentExecutableSearchPath(base, platform);
  if (searchPath) result.PATH = searchPath;
  result.NONINTERACTIVE = "1";
  return result;
}

function stripAnsiEscapes(value: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    if (value.charCodeAt(i) === 0x1b && value[i + 1] === "[") {
      i += 2;
      while (i < value.length) {
        const code = value.charCodeAt(i);
        i += 1;
        if (code >= 0x40 && code <= 0x7e) break;
      }
      continue;
    }
    out += value[i]!;
    i += 1;
  }
  return out;
}

export function sanitizeRuntimeManageDiagnostic(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const lines = stripAnsiEscapes(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const lastLine = lines.at(-1);
  if (!lastLine) return undefined;
  const scrubbedUrls = lastLine.replace(URL_CREDENTIALS_PATTERN, "$1[REDACTED]@");
  const redacted = redactCredentials(scrubbedUrls);
  let cleaned = "";
  for (let i = 0; i < redacted.length; i += 1) {
    const code = redacted.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      cleaned += " ";
    } else {
      cleaned += redacted[i]!;
    }
  }
  const collapsed = cleaned.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return truncateCodePointsWithEllipsis(collapsed, DIAGNOSTIC_MAX_CHARS);
}

async function readBoundedTailStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (value.byteLength >= MAX_OUTPUT_BYTES) {
        chunks.length = 0;
        chunks.push(value.subarray(value.byteLength - MAX_OUTPUT_BYTES));
        total = MAX_OUTPUT_BYTES;
        continue;
      }
      chunks.push(value);
      total += value.byteLength;
      while (total > MAX_OUTPUT_BYTES && chunks.length > 0) {
        const excess = total - MAX_OUTPUT_BYTES;
        const head = chunks[0]!;
        if (head.byteLength <= excess) {
          chunks.shift();
          total -= head.byteLength;
        } else {
          chunks[0] = head.subarray(excess);
          total -= excess;
        }
      }
    }
  } catch {
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function killProcessTree(child: Bun.Subprocess, detached: boolean): void {
  if (detached && typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {}
  }
  try {
    child.kill("SIGKILL");
  } catch {}
}

export async function runRuntimeManageSteps(
  steps: readonly RuntimePackageStep[],
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    environment?: Readonly<Record<string, string | undefined>>;
    platform?: NodeJS.Platform;
  },
): Promise<RuntimePackageStepRunResult> {
  const platform = options.platform ?? process.platform;
  const env = sanitizeRuntimeManageEnvironment(options.environment ?? Bun.env, platform);
  const deadline = Date.now() + options.timeoutMs;
  const detached = platform !== "win32";

  for (const step of steps) {
    if (options.signal?.aborted) return { ok: false, cancelled: true };
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { ok: false, timedOut: true };

    let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
    try {
      child = Bun.spawn(step.command, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env,
        ...(detached ? { detached: true } : {}),
      });
    } catch (error) {
      return {
        ok: false,
        diagnostic: sanitizeRuntimeManageDiagnostic(thrownMessage(error)),
      };
    }

    let timedOut = false;
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      killProcessTree(child, detached);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, detached);
    }, remainingMs);
    timer.unref?.();

    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        readBoundedTailStream(child.stdout),
        readBoundedTailStream(child.stderr),
      ]);
      if (cancelled) return { ok: false, cancelled: true };
      if (timedOut) return { ok: false, timedOut: true };
      if (exitCode !== 0) {
        return {
          ok: false,
          exitCode,
          diagnostic:
            sanitizeRuntimeManageDiagnostic(stderr) ?? sanitizeRuntimeManageDiagnostic(stdout),
        };
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
  return { ok: true };
}
