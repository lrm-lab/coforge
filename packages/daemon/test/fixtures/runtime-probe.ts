import type { ExternalCodeAgentProbe } from "#src/code-agent/runtime-executable";

/** The five Claude Code effort levels every effort-capable static model offers. */
export const FULL_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function probeFor(
  runtimes: Record<string, { path: string; version: string; exitCode?: number }>,
): ExternalCodeAgentProbe {
  return {
    which: (name) => runtimes[name]?.path,
    spawn: (executable) => {
      const runtime = Object.values(runtimes).find((candidate) => candidate.path === executable);
      return {
        stdout: new Blob([runtime?.version ?? ""]).stream(),
        exited: Promise.resolve(runtime?.exitCode ?? 0),
      };
    },
  };
}
