// The --range entrypoint ci.yml invokes: the blocking hard rules (hard-rules.ts)
// followed by the warn-only Reviewed-in check (reviewed-in.ts, task #593). The hard
// rules' exit code is this script's; reviewed-in prints warnings and summaries but
// can never fail the run, so it runs even when the rules report violations.
// usage: bun scripts/ci/range-checks.ts --range <base> <head> [--authors-since <rev>]...
import { join } from "node:path";

const args = process.argv.slice(2);
const run = (script: string) =>
  Bun.spawnSync([process.execPath, join(import.meta.dir, script), ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });

const rules = run("hard-rules.ts");
run("reviewed-in.ts");
process.exit(rules.exitCode ?? 1);
