import { randomUUID } from "node:crypto";
import { stopProcJobMemoryScope } from "./proc-job-systemd-scope";
import { spawnDetachedProcJob } from "./proc-job-process";
import {
  CGROUP_ROOT,
  resolveProcScopeControl,
  type ProcScopeControl,
} from "./proc-job-systemd-memory";

export function createProcJobMemoryScopeDetector(
  platform: NodeJS.Platform,
): () => Promise<ProcScopeControl | undefined> {
  let check: Promise<ProcScopeControl | undefined> | undefined;
  let lastCheck = 0;
  return () => {
    if (!check || Date.now() - lastCheck >= 60_000) {
      lastCheck = Date.now();
      check = detectProcJobMemoryScope(platform);
    }
    return check;
  };
}

async function detectProcJobMemoryScope(
  platform: NodeJS.Platform,
): Promise<ProcScopeControl | undefined> {
  if (platform !== "linux") return undefined;
  try {
    const control = resolveProcScopeControl();
    const versionCommand = Bun.spawn([control.systemdRunPath, "--version"], {
      cwd: "/",
      env: control.environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 1_000,
    });
    const [output, versionStatus] = await Promise.all([
      new Response(versionCommand.stdout).text(),
      versionCommand.exited,
    ]);
    const version = /^systemd (\d+)(?:[ \n.~+(-]|$)/.exec(output)?.[1];
    if (versionStatus !== 0 || version === undefined || Number(version) < 253) return undefined;
    const controllers = await Bun.file(`${CGROUP_ROOT}/cgroup.controllers`).text();
    if (!controllers.trim().split(/\s+/).includes("memory")) return undefined;
    const ended = Promise.withResolvers<boolean>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const unit = `coforge-proc-memory-probe-${randomUUID()}.scope`;
      const probe = await spawnDetachedProcJob({
        command: ["/bin/true"],
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        logPath: "/dev/null",
        systemdUnit: unit,
        memoryLimitBytes: 256 * 1024 * 1024,
        scopeControl: control,
        onExit: (code, signal) => ended.resolve(code === 0 && signal === null),
      });
      const expired = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 1_000);
      });
      if (!probe.memoryScope) return undefined;
      if (await Promise.race([ended.promise, expired])) return control;
      await stopProcJobMemoryScope(
        { systemdUnit: unit, memoryScope: probe.memoryScope },
        { platform, force: true },
      );
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return undefined;
  }
}
