import { writeAgentMigrationBundle } from "#src/agent-migration/bundle-writer";
import { selectAgentMigrationWorkspace } from "#src/agent-migration/workspace-selection";

async function main() {
  const workspaceDirectory = process.argv[2];
  if (!workspaceDirectory) throw new Error("workspace directory is required");
  const selection = await selectAgentMigrationWorkspace(workspaceDirectory);
  const releases: Array<() => void> = [];
  let holding = true;
  let inFlight = 0;
  let peak = 0;
  let completed = 0;
  let heldAtIdle: number | undefined;
  const releaseConsumers = () => {
    for (const release of releases.splice(0)) release();
  };
  const onIdle = () => {
    heldAtIdle ??= inFlight;
    releaseConsumers();
  };
  // With consumers held, an empty event loop means packing cannot make further progress.
  // https://bun.com/guides/process/os-signals
  process.on("beforeExit", onIdle);
  try {
    const { manifest } = await writeAgentMigrationBundle({
      workspaceDirectory,
      selection,
      chunkBytes: 1024 * 1024,
      maxBytes: 64 * 1024 * 1024,
      async onChunk() {
        peak = Math.max(peak, ++inFlight);
        if (holding) await new Promise<void>((resolve) => releases.push(resolve));
        inFlight--;
        completed++;
      },
    });
    process.stdout.write(
      `${JSON.stringify({ heldAtIdle, peak, completed, chunks: manifest.chunks.length })}\n`,
    );
  } finally {
    process.off("beforeExit", onIdle);
    holding = false;
    releaseConsumers();
  }
}

// Top-level await keeps Bun alive while packing is blocked, preventing beforeExit.
main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
