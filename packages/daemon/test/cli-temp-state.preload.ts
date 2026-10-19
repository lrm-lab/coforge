/**
 * Every test process that can run the Daemon keeps its Agents' CLI temporary state in a directory of
 * its own. `packages/daemon` and `apps/web` (whose tests build a `DaemonRuntime`) both preload this
 * file from their `bunfig.toml`.
 *
 * The send-draft and consumed-cursor stores default to one directory per OS user under `tmpdir()`,
 * shared by every process of that user: other test processes running at the same time (another
 * worktree's suite, say) and a live Daemon on the same machine. Tests that write or clear that
 * state would then read, overwrite, and delete each other's. The stores' documented overrides point
 * this process at a fresh directory instead, and it is removed once the tests it served have
 * finished (per file under `bun test --isolate`, as `apps/web` runs).
 *
 * A test run inside a CoForge Agent can also inherit a Workspace Daemon's scope variables, which
 * Daemon code under test would act on; they are removed here, and `COFORGE_DAEMON_HOME` (whose
 * default is the machine's real `~/.coforge/daemon`) points at this directory too. A child spawned without an explicit
 * `env` still gets this process's startup environment, so a test that spawns Daemon code passes
 * `env: process.env`.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_DAEMON_ENV_KEYS } from "#src/code-agent/environment";

// macOS tmpdir lives under /var, a symlink; the state stores reject linked ancestors.
const root = mkdtempSync(join(realpathSync(tmpdir()), "coforge-daemon-test-cli-state-"));
process.env.COFORGE_CLI_DRAFT_STATE_DIR = root;
process.env.COFORGE_CLI_CONSUMED_SEQ_STATE_DIR = root;

for (const name of WORKSPACE_DAEMON_ENV_KEYS) delete process.env[name];
process.env.COFORGE_DAEMON_HOME = root;

afterAll(() => rm(root, { recursive: true, force: true }));
