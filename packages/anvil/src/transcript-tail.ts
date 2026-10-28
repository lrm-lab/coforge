/** A host that can read the tail of a file: the one capability the transcript readers need. */
export type TailReader = {
  readFileTail(path: string, tailBytes: number): Promise<{ text: string; startOffset: number }>;
};

/** The lines in the last `tailBytes` of `path`, minus a first line the window cut; `undefined`
 * when the file cannot be read. Claude Code's transcript and Codex's rollout share it, so a
 * cut first line is dropped the same way on both. */
export async function readTailLines(
  path: string,
  tailBytes: number,
  host: TailReader,
): Promise<string[] | undefined> {
  try {
    const { text, startOffset } = await host.readFileTail(path, tailBytes);
    const lines = text.split("\n");
    if (startOffset > 0) lines.shift();
    return lines;
  } catch {
    return;
  }
}
