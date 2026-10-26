import { join } from "node:path";

function userHomeDirectory(): string {
  return Bun.env.HOME ?? Bun.env.USERPROFILE ?? "";
}

/** Resolve the Claude Code CLI, including the executable shipped in the macOS app. */
export async function resolveClaudeCodeExecutable(
  which: (name: string) => string | undefined,
): Promise<string | undefined> {
  const fromPath = which("claude");
  if (fromPath) return fromPath;
  if (process.platform !== "darwin") return undefined;
  for (const candidate of [
    "/Applications/Claude Code URL Handler.app/Contents/MacOS/claude",
    join(userHomeDirectory(), "Applications/Claude Code URL Handler.app/Contents/MacOS/claude"),
    "/Applications/Claude Code.app/Contents/MacOS/claude",
    join(userHomeDirectory(), "Applications/Claude Code.app/Contents/MacOS/claude"),
  ]) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return undefined;
}
