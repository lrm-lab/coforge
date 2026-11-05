import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_ACTIVE_CONTEXT_FILE, AGENT_MEMORY_FILE } from "./agent-workspace-path";
import { CHARS_PER_TOKEN, estimateTokens } from "@lrm/coforge-anvil";

/** Refuses a symlink at the final component, and never blocks on a swapped-in FIFO. */
const OPEN_FLAGS =
  constants.O_RDONLY |
  constants.O_NONBLOCK |
  (process.platform === "win32" ? 0 : constants.O_NOFOLLOW);

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** The head of a file's bytes as text; when cut short, never a split character, and ended at a
 * line end when one is near. */
function headOf(bytes: Uint8Array, truncated: boolean): string {
  let head = new TextDecoder().decode(bytes);
  if (!truncated) return head;
  if (head.endsWith("\uFFFD")) head = head.slice(0, -1);
  const lastNewline = head.lastIndexOf("\n");
  return lastNewline > head.length * 0.8 ? head.slice(0, lastNewline) : head;
}

/** One file's head, as the block shows it. */
type MemorySection = Readonly<{ text: string; complete: boolean }>;

export type StartupMemoryBlock = Readonly<{
  text: string;
  /** Every file that was shown is complete: the Agent need not read them again. */
  complete: boolean;
}>;

/** MEMORY.md's share of a fresh session's block: its index and facts. Independent of the Active
 * Context's share, so a short index never buys a longer Active Context. */
export const STARTUP_MEMORY_BUDGET_TOKENS = 3_000;

/** The Active Context's share — the current state, not a log. */
export const STARTUP_ACTIVE_CONTEXT_BUDGET_TOKENS = 1_000;

/** What one file's section carries, and whether that is all of it. */
async function readSection(path: string, budgetTokens: number): Promise<MemorySection | undefined> {
  const budgetBytes = budgetTokens * CHARS_PER_TOKEN;
  try {
    // The cheap refusal first; the open below is what makes it hold (no swap between the two).
    if (!(await lstat(path)).isFile()) return undefined;
    const file = await open(path, OPEN_FLAGS);
    let buffer: Uint8Array;
    let size: number;
    let read = 0;
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size === 0) return undefined;
      size = info.size;
      buffer = new Uint8Array(Math.min(size, Math.floor(budgetBytes)));
      while (read < buffer.length) {
        const { bytesRead } = await file.read(buffer, read, buffer.length - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
    } finally {
      await file.close();
    }
    const head = headOf(buffer.subarray(0, read), read < size);
    if (head.trim().length === 0) return undefined;
    return { text: head.trimEnd(), complete: Buffer.byteLength(head, "utf8") >= size };
  } catch {
    return undefined;
  }
}

/** One section's XML element, complete or cut, always saying which it is. */
function sectionElement(
  element: "memory" | "active-context",
  file: string,
  section: MemorySection | undefined,
): string | undefined {
  if (!section) return undefined;
  const shownBytes = Buffer.byteLength(section.text, "utf8");
  const attributes = section.complete
    ? `size="${kilobytes(shownBytes)}" complete="true" note="no need to re-read ${file} unless you change it"`
    : `shown="first ${kilobytes(shownBytes)}" tokens="~${estimateTokens(shownBytes)}" complete="false" note="read the file for the rest"`;
  return [`<${element} file="${file}" ${attributes}>`, section.text, `</${element}>`].join("\n");
}

/**
 * The Agent's MEMORY.md and Active Context as one XML-delimited block for the first input of a
 * fresh session, each cut to its own share: MEMORY.md within 3,000 tokens and notes/
 * active-context.md within 1,000. `undefined` when neither file has anything to show.
 *
 * A file that is missing, empty, unreadable or not a regular file contributes no section: a
 * symlink is never followed (the same rule as the System Cleaner's measurement).
 */
export async function buildStartupMemoryBlock(options: {
  agentWorkspaceDirectory: string;
}): Promise<StartupMemoryBlock | undefined> {
  const [memory, activeContext] = await Promise.all([
    readSection(
      join(options.agentWorkspaceDirectory, AGENT_MEMORY_FILE),
      STARTUP_MEMORY_BUDGET_TOKENS,
    ),
    readSection(
      join(options.agentWorkspaceDirectory, AGENT_ACTIVE_CONTEXT_FILE),
      STARTUP_ACTIVE_CONTEXT_BUDGET_TOKENS,
    ),
  ]);
  const sections = [
    sectionElement("memory", AGENT_MEMORY_FILE, memory),
    sectionElement("active-context", AGENT_ACTIVE_CONTEXT_FILE, activeContext),
  ].filter((section) => section !== undefined);
  if (!sections.length) return undefined;
  return {
    text: ["<memory-index>", ...sections, "</memory-index>"].join("\n"),
    complete: (memory?.complete ?? true) && (activeContext?.complete ?? true),
  };
}

/** The block for one fresh session, at the two shares above. */
export function startupMemoryBlock(
  agentWorkspaceDirectory: string,
): Promise<StartupMemoryBlock | undefined> {
  return buildStartupMemoryBlock({ agentWorkspaceDirectory });
}
