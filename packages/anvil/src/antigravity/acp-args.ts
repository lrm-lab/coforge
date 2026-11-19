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
