import {
  codexRuntimeHost,
  codexCatalogHost,
  createCodexAuthHost,
} from "#src/code-agent/codex/host";
import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { CodexProvider } from "@lrm/coforge-anvil/codex";
import { discoverCodexCatalog } from "@lrm/coforge-anvil/codex";
import { CodexRuntimeAuthAdapter } from "@lrm/coforge-anvil/codex";
import { readCodexUsage } from "@lrm/coforge-anvil/codex";
import { COFORGE_DAEMON_VERSION } from "#src/version";

for (const mode of ["session", "catalog", "usage", "auth-server", "auth-cli"] as const) {
  test(
    "Codex " + mode + " preserves its effective environment and initialization identity",
    async () => {
      const root = await mkdtemp(join(realpathSync(tmpdir()), "codex-host-"));
      const trace = join(root, "trace.json");
      const home = join(root, "home");
      const executable = join(root, "installed-codex");
      const emptyPath = join(root, "empty");
      const fixture = new URL("./fixtures/codex-host.ts", import.meta.url).pathname;
      const inherited = {
        HOME: home,
        CODEX_HOME: join(root, "profile"),
        PATH: emptyPath,
        CODEX_HOST_TRACE: trace,
        CODEX_HOST_SOURCE: "inherited",
        NO_COLOR: "base-color",
        FORCE_COLOR: "17",
        GIT_CONFIG_COUNT: "0",
        COFORGE_AGENT_PROXY_URL: "stale-proxy",
        COFORGE_DAEMON_HOME: "stale-daemon",
      };
      const previous = Object.fromEntries(Object.keys(inherited).map((key) => [key, Bun.env[key]]));
      try {
        await mkdir(emptyPath);
        const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
        await Bun.write(
          executable,
          "#!/bin/sh\nexec " + quote(process.execPath) + " " + quote(fixture) + ' "$@"\n',
        );
        await chmod(executable, 0o755);
        Object.assign(Bun.env, inherited);
        // Neither the inherited PATH nor its only directory contains a codex executable.
        expect(Bun.which("codex", { PATH: emptyPath })).toBeNull();
        expect(inherited.PATH.split(delimiter)).not.toContain(root);
        if (mode === "session") {
          const session = await new CodexProvider({
            host: codexRuntimeHost,
            command: [executable, "app-server"],
          }).createAgentSession({
            agentWorkspaceDirectory: root,
            instructions: "Fixture instructions",
            environment: {
              HOME: home,
              CODEX_HOME: inherited.CODEX_HOME,
              CODEX_HOST_SOURCE: "declared",
              COFORGE_CURRENT_AGENT_ID: "trusted-agent",
            },
            runtime: {
              provider: "codex",
              model: "host-model",
              reasoning: "high",
              envVars: { CODEX_HOST_SOURCE: "runtime", COFORGE_AGENT_PROXY_URL: "spoofed-proxy" },
            },
            gitHooks: { kind: "hooks-path", hooksDir: join(root, "hooks") },
          });
          await session.dispose();
        } else if (mode === "catalog") {
          const result = await discoverCodexCatalog(
            [executable, "app-server"],
            root,
            inherited,
            codexCatalogHost,
            1_000,
            true,
          );
          expect(result?.models[0]?.id).toBe("host-model");
        } else if (mode === "usage") {
          const result = await readCodexUsage(root, {
            host: codexRuntimeHost,
            command: [executable, "app-server"],
            timeoutMs: 1_000,
          });
          expect(result?.health).toBe("ok");
        } else {
          const adapter = new CodexRuntimeAuthAdapter({
            host: createCodexAuthHost({ environment: inherited }),
            command: [executable, "app-server"],
          });
          if (mode === "auth-cli")
            expect(
              await adapter.readStatus({ workingDirectory: root, timeoutMs: 1_000 }),
            ).toMatchObject({ state: "logged_in" });
          else
            expect(
              await adapter.startLogin(
                { workingDirectory: root, timeoutMs: 1_000 },
                {
                  onEvent() {},
                  async prompt() {
                    throw new Error("fixture does not prompt");
                  },
                },
              ),
            ).toMatchObject({ status: "logged_in" });
        }
        const observed = await Bun.file(trace).json();
        expect(observed.environment).toMatchObject({
          HOME: home,
          CODEX_HOME: inherited.CODEX_HOME,
          FORCE_COLOR: "0",
          NO_COLOR: mode === "catalog" || mode === "usage" ? "base-color" : "1",
          CODEX_HOST_SOURCE: mode === "session" ? "declared" : "inherited",
          COFORGE_AGENT_PROXY_URL: null,
          COFORGE_DAEMON_HOME: null,
          COFORGE_CURRENT_AGENT_ID: mode === "session" ? "trusted-agent" : null,
        });
        if (mode === "session") {
          expect(observed.gitConfig).toContainEqual(["GIT_CONFIG_KEY_5", "core.hooksPath"]);
          expect(observed.gitConfig).toContainEqual(["GIT_CONFIG_VALUE_5", join(root, "hooks")]);
        }
        if (mode === "auth-cli") expect(observed.argv).toEqual(["login", "status"]);
        else
          expect(observed.initialize).toEqual({
            clientInfo: {
              name: mode === "usage" ? "coforge-daemon-usage" : "coforge_daemon",
              title: mode === "usage" ? "CoForge Daemon Usage" : "CoForge Daemon",
              version: COFORGE_DAEMON_VERSION,
            },
            capabilities: { experimentalApi: mode === "usage" || mode === "auth-server" },
          });
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete Bun.env[key];
          else Bun.env[key] = value;
        }
        await rm(root, { recursive: true, force: true });
      }
    },
    2 * 5_000 + 5_000,
  );
}
