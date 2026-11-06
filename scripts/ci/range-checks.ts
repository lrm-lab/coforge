// The --range entrypoint ci.yml invokes: the blocking hard rules (hard-rules.ts)
// and whitespace check (diff-check.ts, task #628), then the warn-only
// Reviewed-in check (reviewed-in.ts, task #593). The hard rules' exit code is
// this script's whenever they fail — their exit 2 (bad input) must reach
// pre-push as a skip — and the whitespace check's when they pass; reviewed-in
// prints warnings and summaries but can never fail the run, so it runs even
// when the rules report violations.
// usage: bun scripts/ci/range-checks.ts --range <base> <head> [--authors-since <rev>]...
import { join } from "node:path";

const args = process.argv.slice(2);
const run = (script: string) =>
  Bun.spawnSync([process.execPath, join(import.meta.dir, script), ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });

const rules = run("hard-rules.ts");
const diff = run("diff-check.ts");
run("reviewed-in.ts");
const rulesCode = rules.exitCode ?? 1;
process.exit(rulesCode === 0 ? (diff.exitCode ?? 1) : rulesCode);
