import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const RULE_FILE = "coforge-agent.mdc";

export interface CursorInstructions {
  /** The private rule file's absolute path inside the workspace's `.cursor/rules`. */
  readonly path: string;
  remove(): Promise<void>;
}

/**
 * Standing instructions ride cursor's own rule channel: one private `.mdc` file inside the
 * workspace's `.cursor/rules`, because `cursor-agent acp` offers no env or config overlay
 * (the `acp` command is hidden and takes no options, verified on 2026.10.22). The filename is
 * fixed so a daemon crash cannot stack a second always-on copy beside the first; an existing
 * rules directory keeps its permissions, while one this launch creates is private and is
 * removed when the session ends. Sending the briefing as a first `session/prompt` would land
 * it in the conversation instead.
 */
export async function createCursorInstructions(
  workspaceDirectory: string,
  instructions: string,
): Promise<CursorInstructions> {
  const cursorDirectory = join(workspaceDirectory, ".cursor");
  const rules = join(cursorDirectory, "rules");
  const created = !existsSync(rules);
  await mkdir(rules, { recursive: true });
  if (created) await chmod(rules, 0o700);
  const path = join(rules, RULE_FILE);
  await writeFile(
    path,
    `---\ndescription: CoForge Agent standing instructions\nalwaysApply: true\n---\n${instructions}\n`,
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
  // The file is workspace-private: keep it out of git status only when the workspace root is
  // itself a repository — never a parent repo, never `git` on PATH (the daemon environment and
  // a missing executable would break the launch). A `.git` file names its real dir for worktrees.
  const exclude = await gitExcludePath(workspaceDirectory);
  if (exclude) {
    const pattern = `.cursor/rules/${RULE_FILE}`;
    const existing = await Bun.file(exclude)
      .text()
      .catch(() => "");
    if (!existing.split("\n").some((line) => line.trim() === pattern)) {
      const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
      await appendFile(exclude, `${prefix}${pattern}\n`).catch(() => undefined);
    }
  }
  let removal: Promise<void> | undefined;
  return {
    path,
    remove: () =>
      (removal ??= (async () => {
        await rm(path, { force: true });
        // Take away only an empty rules dir this launch made; a user's own rules stay.
        if (created) {
          await rmdir(rules).catch(() => undefined);
          await rmdir(cursorDirectory).catch(() => undefined);
        }
      })()),
  };
}

/** The workspace's own `info/exclude` when the workspace root is a repository — `.git` as a
 * dir, or a `.git` file's `gitdir:` target (worktrees keep shared metadata in the `commondir`
 * the file names). Anything else (no repo, a subdirectory of a repo, unreadable `.git`) is
 * skipped. */
async function gitExcludePath(workspaceDirectory: string): Promise<string | undefined> {
  try {
    const dot = join(workspaceDirectory, ".git");
    if (!existsSync(dot)) return undefined;
    const stat = await Bun.file(dot).stat();
    let gitdir = dot;
    if (!stat.isDirectory()) {
      const firstLine = (await Bun.file(dot).text()).split("\n")[0] ?? "";
      const target = firstLine.startsWith("gitdir:") ? firstLine.slice(7).trim() : "";
      if (!target) return undefined;
      gitdir = target.startsWith("/") ? target : join(workspaceDirectory, target);
      // A linked worktree's gitdir holds no `info/` — the shared dir it names does.
      const commondir = await Bun.file(join(gitdir, "commondir"))
        .text()
        .catch(() => "");
      const common = commondir.trim();
      if (common) gitdir = common.startsWith("/") ? common : join(gitdir, common);
    }
    const info = join(gitdir, "info");
    await mkdir(info, { recursive: true });
    return join(info, "exclude");
  } catch {
    // No repo or unreadable `.git`: the exclude is best-effort, never a launch failure.
  }
  return undefined;
}
