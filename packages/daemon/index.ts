export * from "./src/daemon-public-api";
import { runDaemon } from "./src/daemon-public-api";

// Standalone source/development harness; releases enter through Computer.
if (import.meta.main) await runDaemon(Bun.argv.slice(2));
