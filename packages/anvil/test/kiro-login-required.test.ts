import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { kiroProvider } from "./fixtures/kiro-host";

// macOS tmpdir lives under /var, a symlink; the Kiro provider rejects a linked
// agent profile directory (comparing realpath to the literal resolved path).
const tempRoot = realpathSync(tmpdir());
const command = [process.execPath, new URL("./fixtures/kiro-acp.ts", import.meta.url).pathname];

/**
 * A login Kiro no longer accepts is terminal for the launch: the daemon must not wait out the
 * handshake's own bound (30s) nor retry the launch, and must report the one action a person can
 * take. These cases fail on the old code by timing out or by surfacing a plain Error.
 */
test("a Kiro launch whose login is not usable is reported as login required", async () => {
  const cwd = await mkdtemp(join(tempRoot, "kiro-login-required-"));
  try {
    const started = Date.now();
    const failure = kiroProvider({ command: [...command, "--login-required"] }).createAgentSession({
      agentWorkspaceDirectory: cwd,
      instructions: "Keep the asymmetric marker 719 in the system prompt.",
    });
    await expect(failure).rejects.toMatchObject({
      code: "runtime_login_required",
      message: "Kiro CLI is not logged in on this Computer",
    });
    // The point of the detection is that it does not wait for the handshake's 30s bound.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await readdir(join(cwd, ".kiro/agents"))).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a login Kiro accepts but cannot serve is reported as login required, not a timeout", async () => {
  // Logged in without a profile: `session/new` offers no model, and asking for one answers
  // successfully while the reason rides the next session update. Without the elicitation the
  // launch waits out the 30s configuration deadline and reports a timeout.
  const cwd = await mkdtemp(join(tempRoot, "kiro-profile-missing-"));
  try {
    const started = Date.now();
    const failure = kiroProvider({
      command: [...command, "--profile-missing"],
      configTimeoutMs: 30,
    }).createAgentSession({
      agentWorkspaceDirectory: cwd,
      instructions: "Keep the asymmetric marker 719 in the system prompt.",
      runtime: { provider: "kiro", model: "auto", reasoning: "" },
    });
    await expect(failure).rejects.toMatchObject({ code: "runtime_login_required" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await readdir(join(cwd, ".kiro/agents"))).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a handshake failure that is not about the login keeps its own error", async () => {
  const cwd = await mkdtemp(join(tempRoot, "kiro-not-auth-"));
  try {
    await expect(
      kiroProvider({ command: [...command, "--unknown-failure"] }).createAgentSession({
        agentWorkspaceDirectory: cwd,
        // A profile whose prompt the fixture refuses: an ordinary handshake failure.
        instructions: "another prompt",
      }),
    ).rejects.toThrow("Incorrect v3 profile or launch");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
