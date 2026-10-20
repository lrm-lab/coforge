import { dirname, join } from "node:path";

import { bunChildEnv } from "./local-bun";
import { DEFAULT_FRONTEND_PORT, readListenPort } from "./listen-port";
import { runSupervisedBun } from "./supervised-bun";

const port = readListenPort(process.env, DEFAULT_FRONTEND_PORT);
const webRoot = join(import.meta.dir, "..");

// Vite's own JS entry, not `bun --bun vite`: that starts Vite's bin as a child process of its own,
// which does not run the preload and is not the child the launcher signals. Vite's package exports
// do not expose its bin, so it is found through its package.json.
const vitePackage = Bun.resolveSync("vite/package.json", webRoot);
const viteBin: string = (await Bun.file(vitePackage).json()).bin.vite;
const viteEntry = join(dirname(vitePackage), viteBin);

const exitCode = await runSupervisedBun(
  ["--bun", viteEntry, "dev", "--port", String(port), "--host", "127.0.0.1", "--strictPort"],
  { cwd: webRoot, env: bunChildEnv({ PORT: String(port) }) },
);

process.exit(exitCode);
