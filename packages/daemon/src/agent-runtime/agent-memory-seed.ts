import { getLogger } from "@logtape/logtape";
import { ensureAgentMigrationIgnoreFile } from "#src/agent-migration/ignore-file";
import { AGENT_CODE_DIRECTORY, AGENT_MEMORY_FILE } from "#src/agent-runtime/agent-workspace-path";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collapseWhitespace } from "@lrm/coforge-anvil";

const logger = getLogger(["coforge", "daemon", "agent-runtime", "agent-memory-seed"]);

/** The subset of the server-authored Agent identity (`AgentLaunchIdentity`) the seeded MEMORY.md
 * needs: only the name for its title. The role is not copied — the standing prompt carries the
 * current description on every launch, and a copy would go stale the moment an owner edits it.
 * Declared locally instead of importing that type so this module keeps a narrow, independent seam
 * from the standing-prompt builder. */
export type AgentMemorySeedIdentity = {
  name?: string;
  displayName?: string;
};

const ACTIVE_CONTEXT_SEED = `# Active Context

Current state, not a log: overwrite it when work starts, finishes or blocks — next step, blocker, progress only.
`;

/**
 * Builds the content of a freshly seeded MEMORY.md for one Agent: a title, a Rules slot, a Facts
 * area written one fact per line, and Pointers for what is too long to keep here — the shape the
 * Agent Manual's memory topic tells the Agent to keep. MEMORY.md holds the index and the facts
 * themselves; only long material (procedures, reports, reference) lives in notes/<topic>.md
 * behind a one-line pointer, and the Active Context stays in notes/active-context.md.
 *
 * There is no Role section: a role is the Agent's description, which the standing prompt carries
 * from the server on every launch, and a copy here would disagree with it after one edit.
 *
 * The name is written by people, so it is collapsed to a single line: it cannot break the
 * `# <name>` heading.
 */
export function buildInitialMemoryMd(identity: AgentMemorySeedIdentity): string {
  const rawName = identity.displayName || identity.name;
  const title = rawName ? collapseWhitespace(rawName) : "Agent";
  return `# ${title}

## Rules (never change)
-

## Facts
<!-- One fact per line. When a human decides or prefers something, or you hit a pitfall, edit the
line here and merge duplicates. -->

## Pointers
- notes/active-context.md   current state: next step, blocker, progress (overwrite it as work moves)
- notes/<topic>.md   long material (procedures, reports, reference); one line here pointing at it
`;
}

async function writeNewFile(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return;
    throw error;
  }
}

/**
 * Writes the seeded MEMORY.md and notes/active-context.md into an Agent's workspace on its first
 * launch, and creates the `notes/` / `code/` layout plus the migration ignore file that leaves
 * `code/` behind by default. Never overwrites an existing file — once written, an Agent owns each
 * of them and this seed step never touches it again (`flag: "wx"` fails with `EEXIST`, which is
 * swallowed here). A workspace from before the seed wrote no notes/work-log.md keeps whatever it
 * has; nothing is deleted. After a Full Reset clears the Agent workspace (the record store's
 * `clearWorkspace`), the files are gone along with every other workspace file, so the next
 * launch's call to this function seeds them again with no special-casing required.
 *
 * Missing directories and notes files are created even when MEMORY.md already exists, so an older
 * workspace still gets the layout, including notes/active-context.md. An existing MEMORY.md is
 * never rewritten, even one that still carries an Active Context section. A seeding failure
 * (anything other than the file already existing) is logged and swallowed: it must never fail the
 * Agent launch that is already under way.
 */
export async function seedAgentMemory(
  agentWorkspaceDirectory: string,
  identity: AgentMemorySeedIdentity,
): Promise<void> {
  const memoryPath = join(agentWorkspaceDirectory, AGENT_MEMORY_FILE);
  const notesDirectory = join(agentWorkspaceDirectory, "notes");

  try {
    // MEMORY.md first: a missing workspace directory fails here with ENOENT and is swallowed,
    // matching the previous seed (it must not mkdir the Agent workspace into existence).
    await writeNewFile(memoryPath, buildInitialMemoryMd(identity));
    await mkdir(notesDirectory, { recursive: true });
    await mkdir(join(agentWorkspaceDirectory, AGENT_CODE_DIRECTORY), { recursive: true });
    await writeNewFile(join(notesDirectory, "active-context.md"), ACTIVE_CONTEXT_SEED);
    await ensureAgentMigrationIgnoreFile(agentWorkspaceDirectory);
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") return;
    logger.error("Agent memory seed did not complete", {
      event: "agent_memory_seed:failed",
      agent_workspace_directory: agentWorkspaceDirectory,
      error_code: (error as { code?: string }).code,
    });
  }
}
