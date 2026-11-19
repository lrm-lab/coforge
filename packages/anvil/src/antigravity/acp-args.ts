import { posix, win32 } from "node:path";

const SESSION_FLAGS = ["--dangerously-skip-permissions", "--process-per-session"] as const;

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return environment[name];
  const target = name.toLowerCase();
  let matched: string | undefined;
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() === target) matched = value;
  }
  return matched;
}

export function antigravityGeminiDirectory(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const custom = environmentValue(environment, "GEMINI_HOME", platform)?.trim();
  if (custom) return custom;
  if (platform === "win32") {
    const home = environmentValue(environment, "USERPROFILE", "win32")?.trim();
    return home ? win32.join(home, ".gemini") : undefined;
  }
  const home = (environment.HOME ?? environment.USERPROFILE)?.trim();
  return home ? posix.join(home, ".gemini") : undefined;
}

export function antigravityUsesDefaultState(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const custom = environmentValue(environment, "GEMINI_HOME", platform)?.trim();
  if (!custom) return true;
  if (platform === "win32") {
    const home = environmentValue(environment, "USERPROFILE", "win32")?.trim();
    if (!home) return false;
    return win32.resolve(custom).toLowerCase() === win32.resolve(home, ".gemini").toLowerCase();
  }
  const home = environment.HOME?.trim();
  if (!home) return false;
  return posix.resolve(custom) === posix.resolve(home, ".gemini");
}

export function antigravityGeminiDirArgs(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  const directory = environmentValue(environment, "GEMINI_HOME", platform)?.trim();
  return directory ? ["--gemini-dir", directory] : [];
}

export function antigravityAcpSessionExtraArgs(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  return [...SESSION_FLAGS, ...antigravityGeminiDirArgs(environment, platform)];
}
