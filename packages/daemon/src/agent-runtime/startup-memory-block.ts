import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_MEMORY_FILE } from "./agent-workspace-path";
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

export type StartupMemoryBlock = Readonly<{
  text: string;
  /** All of MEMORY.md is in `text`: the Agent need not read the file. */
  complete: boolean;
}>;

/**
 * The Agent's MEMORY.md as an XML-delimited block for the first input of a fresh session: its
 * head within `budgetTokens`, and whether that is all of it, so the Agent need not read it again.
 * `undefined` when the file is missing, empty, unreadable, or not a regular file: a symlink is
 * never followed (the same rule as the System Cleaner's measurement).
 */
export async function buildStartupMemoryBlock(options: {
  agentWorkspaceDirectory: string;
  budgetTokens: number;
}): Promise<StartupMemoryBlock | undefined> {
  const budgetBytes = options.budgetTokens * CHARS_PER_TOKEN;
  const path = join(options.agentWorkspaceDirectory, AGENT_MEMORY_FILE);
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
    const shownBytes = Buffer.byteLength(head, "utf8");
    const complete = shownBytes >= size;
    const attributes = complete
      ? `size="${kilobytes(size)}" complete="true" note="no need to re-read ${AGENT_MEMORY_FILE} unless you change it"`
      : `size="${kilobytes(size)}" tokens="~${estimateTokens(size)}" shown="first ${kilobytes(shownBytes)}" note="read the file for the rest"`;
    return {
      text: [
        `<memory-index file="${AGENT_MEMORY_FILE}" ${attributes}>`,
        head.trimEnd(),
        "</memory-index>",
      ].join("\n"),
      complete,
    };
  } catch {
    return undefined;
  }
}
