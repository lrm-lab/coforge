import { join } from "node:path";

import { bunChildEnv } from "./local-bun";
import { runSupervisedBun } from "./supervised-bun";

const SERVER_ENTRY_RELATIVE = ".output/server/index.mjs";

/** Run the compiled Nitro production server. Requires `./scripts/build-prod.sh`. */
export async function runNitro(port: number): Promise<void> {
  const webRoot = join(import.meta.dir, "..");
  const serverEntry = join(webRoot, SERVER_ENTRY_RELATIVE);

  if (!(await Bun.file(serverEntry).exists())) {
    console.error(`Missing web production build (${SERVER_ENTRY_RELATIVE}).`);
    console.error("Run: ./scripts/build-prod.sh");
    process.exit(1);
  }

  // Default to localhost: the printed origin is the one people open, and a session cookie is
  // host-only, so the host they type must be the host they signed in on.
  const host = process.env.HOST?.trim() || "localhost";
  console.log(`==> Starting production Nitro server on http://${host}:${port}`);

  const exitCode = await runSupervisedBun([serverEntry], {
    cwd: webRoot,
    env: bunChildEnv({
      HOST: host,
      PORT: String(port),
      NODE_ENV: process.env.NODE_ENV?.trim() || "production",
    }),
  });

  process.exit(exitCode);
}
