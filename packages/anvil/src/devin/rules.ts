import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Devin has no per-session system-prompt field on ACP. Its always-on rules are the documented
 * injection point: `.devin/rules/<name>.md` with `trigger: always_on` is loaded at session start
 * (Devin CLI docs, "Rules & AGENTS.md"). The daemon writes one private file per session in the
 * Agent workspace and removes it on dispose; a project `AGENTS.md` is never touched.
 */
export const DEVIN_RULE_PREFIX = "coforge-runtime-";
/** A leftover rule from a crashed process is stale; a file this fresh may belong to a session
 * that another process is starting at the same moment, so it is left alone. */
const STALE_RULE_AGE_MS = 60_000;
/** Rule files of this process's open sessions. A long session's file is old but not stale, so the
 * sweep skips these whatever their age. */
const liveRulePaths = new Set<string>();

export interface DevinRuleFile {
  readonly path: string;
  remove(): Promise<void>;
}

export async function createDevinRuleFile(
  agentWorkspaceDirectory: string,
  instructions: string,
): Promise<DevinRuleFile> {
  // The workspace itself may sit under a symlinked root (macOS `/var`); only the rule path the
  // Agent can create inside it must not redirect the write elsewhere.
  const directory = join(await realpath(agentWorkspaceDirectory), ".devin", "rules");
  await mkdir(directory, { recursive: true });
  if ((await realpath(directory)) !== directory)
    throw new Error("Devin rules directory must not be a symlink");
  await removeStaleRuleFiles(directory);
  const path = join(directory, `${DEVIN_RULE_PREFIX}${randomUUID()}.md`);
  const text = `---\ndescription: "CoForge runtime instructions"\ntrigger: always_on\n---\n\n${instructions.trimEnd()}\n`;
  try {
    await writeFile(path, text, { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  liveRulePaths.add(path);
  let removal: Promise<void> | undefined;
  return {
    path,
    remove: () => (removal ??= rm(path, { force: true }).finally(() => liveRulePaths.delete(path))),
  };
}

/** Only CoForge's own rule files are considered; a user's rule in the same directory stays. */
async function removeStaleRuleFiles(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_RULE_AGE_MS;
  for (const name of names) {
    if (!name.startsWith(DEVIN_RULE_PREFIX) || !name.endsWith(".md")) continue;
    const path = join(directory, name);
    if (liveRulePaths.has(path)) continue;
    try {
      if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
    } catch {
      // Another session may have removed it first.
    }
  }
}
