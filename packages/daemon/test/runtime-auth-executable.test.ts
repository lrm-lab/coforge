import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_LOGIN_STATUS_TIMEOUT_MS } from "#src/code-agent/codex/auth";

// The probe runs with an owned HOME and empty PATH, so even the broken adapter cannot read
// a real account. The Codex installer directory is outside the enriched search path too.
for (const provider of ["codex", "claude-code"] as const) {
  test(
    `${provider} auth uses the discovered executable and runtime environment`,
    async () => {
      const home = await mkdtemp(join(tmpdir(), "coforge-auth-executable-"));
      const bin = join(home, ".local", "bin");
      const install = join(home, "codex-install");
      const emptyPath = join(home, "empty");
      try {
        await Promise.all(
          [bin, install, emptyPath].map((path) => mkdir(path, { recursive: true })),
        );
        const helper = join(bin, "auth-fixture-helper");
        await Bun.write(helper, "#!/bin/sh\nexit 0\n");
        await chmod(helper, 0o755);
        const executable = join(
          provider === "codex" ? install : bin,
          provider === "codex" ? "codex" : "claude",
        );
        await Bun.write(
          executable,
          `#!/bin/sh
[ "$HOME" = "$AUTH_FIXTURE_HOME" ] || exit 7
[ "$CODEX_HOME" = "$HOME/codex-profile" ] || exit 8
[ "$CLAUDE_CONFIG_DIR" = "$HOME/claude-profile" ] || exit 9
[ -z "$COFORGE_AGENT_PROXY_URL" ] || exit 10
auth-fixture-helper || exit 11
${provider === "codex" ? 'echo "Logged in using ChatGPT" >&2' : 'echo \'{"loggedIn":true,"authMethod":"oauth"}\''}
`,
        );
        await chmod(executable, 0o755);
        const child = Bun.spawn({
          cmd: [
            process.execPath,
            join(import.meta.dir, "fixtures/runtime-auth-registry.ts"),
            provider,
          ],
          cwd: home,
          env: {
            HOME: home,
            PATH: emptyPath,
            AUTH_FIXTURE_HOME: home,
            CODEX_HOME: join(home, "codex-profile"),
            CLAUDE_CONFIG_DIR: join(home, "claude-profile"),
            CODEX_INSTALL_DIR: install,
            COFORGE_AGENT_PROXY_URL: "fixture-stale-capability",
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: CODEX_LOGIN_STATUS_TIMEOUT_MS,
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
        expect(JSON.parse(stdout)).toMatchObject({ provider, state: "logged_in" });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
    CODEX_LOGIN_STATUS_TIMEOUT_MS + 1_000,
  );
}
