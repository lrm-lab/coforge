export async function probeClaudeCodeVersion(
  executable: string,
  spawn: (executable: string) => {
    stdout: ReadableStream<Uint8Array>;
    exited: Promise<number>;
    kill?(): void;
  },
  timeoutMs = 5_000,
): Promise<string | undefined> {
  const child = spawn(executable);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.all([new Response(child.stdout).text(), child.exited]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          child.kill?.();
          reject(new Error("Claude Code version probe timed out"));
        }, timeoutMs);
      }),
    ]);
    const [output, exitCode] = result;
    if (exitCode !== 0) return undefined;
    return output.trim().match(/\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
  } catch {
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
    child.kill?.();
  }
}
