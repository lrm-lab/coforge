import type { CatalogCommandRunner, PerTurnSessionHost } from "@lrm/coforge-anvil";
import { withDeadline } from "@lrm/coforge-anvil";

/** The fixture never spawns descendants. Production tree ownership is tested by daemon. */
export const fixturePerTurnHost: PerTurnSessionHost = {
  buildEnvironment(options, policy) {
    return { ...options.runtime?.envVars, ...options.environment, ...policy.environment };
  },
  processTreeSpawner: {
    spawn(command, cwd, environment) {
      const child = Bun.spawn({
        cmd: [...command],
        cwd,
        env: { ...environment },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        child: {
          get pid() {
            return child.pid;
          },
          exited: child.exited,
          get exitCode() {
            return child.exitCode;
          },
          stdin: {
            write(value) {
              child.stdin.write(value);
              return true;
            },
            end() {
              child.stdin.end();
            },
            async flush() {
              await child.stdin.flush();
            },
          },
          stdout: child.stdout,
          stderr: child.stderr,
          kill: (signal) => child.kill(signal),
        },
        async terminate(force) {
          child.kill(force ? "SIGKILL" : "SIGTERM");
        },
        async waitForExit(timeoutMs) {
          return withDeadline(
            child.exited.then(() => true),
            timeoutMs,
            () => new Error("Fixture did not exit"),
          ).catch(() => false);
        },
      };
    },
  },
};

export const fixtureCatalogCommand: CatalogCommandRunner = async (
  command,
  cwd,
  environment,
  timeoutMs,
) => {
  const child = Bun.spawn({
    cmd: [...command],
    cwd,
    env: { ...environment, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  try {
    return await withDeadline(
      Promise.all([new Response(child.stdout).text(), child.exited]).then(([output, exitCode]) => ({
        output,
        exitCode,
      })),
      timeoutMs,
      () => new Error("Fixture catalog timed out"),
    );
  } finally {
    child.kill();
  }
};
