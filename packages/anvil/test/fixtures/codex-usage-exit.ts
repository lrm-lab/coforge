import { fixtureCodexHost } from "./codex-host";
import { readCodexUsage } from "@lrm/coforge-anvil/codex";

const fixture = new URL("./codex-app-server.ts", import.meta.url).pathname;
const outcome = await readCodexUsage(process.cwd(), {
  host: fixtureCodexHost,
  command: [process.execPath, fixture, process.argv[2]!],
  timeoutMs: 30_000,
}).then(
  (snapshot) => (snapshot ? { kind: "snapshot", health: snapshot.health } : { kind: "null" }),
  (error: Error) => ({ kind: "error", message: error.message }),
);
console.log(JSON.stringify(outcome));

// An unreferenced watchdog cannot hold a clean process open. After the public call and its
// disposal finish, leftover request deadlines would keep it alive long enough to fire this.
setTimeout(() => {
  console.error("Completed Codex usage left the caller's event loop alive");
  process.exit(1);
}, 2_000).unref();
