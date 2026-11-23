import { coordinatorServiceName, detachedPid, systemdPresent } from "@lrm/coforge-daemon";
import { inspectSupervisor } from "@lrm/coforge-daemon/src/daemon-host/external-supervisor";
import { probeLinuxCoordinator } from "#src/status/linux-status-ports";

export async function verifyRestartServiceTarget(input: {
  platform: "darwin" | "linux" | "win32";
  stateDirectory: string;
  coordinatorPid: number | undefined;
}): Promise<boolean> {
  if (!input.coordinatorPid || input.platform === "win32") return false;
  const serviceName = coordinatorServiceName(input.platform);
  const servicePid =
    input.platform === "darwin"
      ? await darwinRestartPid(serviceName)
      : await linuxRestartPid(input.stateDirectory, serviceName);
  return servicePid === input.coordinatorPid;
}

async function linuxRestartPid(
  stateDirectory: string,
  serviceName: string,
): Promise<number | null> {
  if (!systemdPresent()) return detachedPid(stateDirectory);
  const external = await inspectSupervisor(stateDirectory);
  if (external && !external.reachable) return null;
  if (external?.unitLoaded) return external.mainPid;
  return (await probeLinuxCoordinator(serviceName)).pid;
}

async function darwinRestartPid(serviceName: string): Promise<number | null> {
  const target = `gui/${process.getuid?.() ?? 0}/${serviceName}`;
  const child = Bun.spawn(["launchctl", "print", target], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 5_000,
  });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (code !== 0) return null;
  const pid = /^\tpid = (\d+)\s*$/mu.exec(stdout)?.[1];
  return pid ? Number(pid) : null;
}
