import { definePlugin } from "nitro";

import { validateStartupConfig } from "#src/server/startup-config.server";

/**
 * Nitro server plugin: checks deployment configuration when the server starts. The Start SSR
 * entry (`src/server.ts`) loads lazily, on the first request, so its own check cannot fail the
 * boot. This runs in Nitro's environment, whose module state is separate from the SSR one's, so it
 * validates a copy of the environment, installing and logging nothing; the entry still installs what requests
 * read. A rejected config ends the process with status 1.
 * https://nitro.build/docs/plugins
 */
export default definePlugin(() => {
  validateStartupConfig({ ...process.env }).catch((error: unknown) => {
    console.error("Invalid deployment configuration; stopping.", error);
    process.exit(1);
  });
});
