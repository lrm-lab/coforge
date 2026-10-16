export const COMPUTER_ID_LABEL = "coforge.computer_id";
export const CONTAINER_STATE_MOUNT = "/root/.coforge";

export function serviceName(computerId: string): string {
  return `coforge-${computerId}`;
}

export function dockerServiceFindArgs(computerId: string): string[] {
  return ["service", "ls", "-q", "--filter", `label=${COMPUTER_ID_LABEL}=${computerId}`];
}

export function dockerServiceCreateArgs(input: {
  computerId: string;
  image: string;
  env: Record<string, string>;
}): string[] {
  const args = [
    "service",
    "create",
    "--no-resolve-image",
    "--name",
    serviceName(input.computerId),
    "--replicas",
    "1",
    "--restart-condition",
    "any",
    "--label",
    `${COMPUTER_ID_LABEL}=${input.computerId}`,
    "--mount",
    `type=volume,src=${serviceName(input.computerId)},dst=${CONTAINER_STATE_MOUNT}`,
  ];
  for (const [key, value] of Object.entries(input.env)) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(input.image);
  return args;
}

export function dockerServiceRemoveArgs(computerId: string): string[] {
  return ["service", "rm", serviceName(computerId)];
}

export function dockerVolumeRemoveArgs(computerId: string): string[] {
  return ["volume", "rm", serviceName(computerId)];
}

export function dockerTaskFindArgs(computerId: string): string[] {
  return ["ps", "-q", "--filter", `label=com.docker.swarm.service.name=${serviceName(computerId)}`];
}

export function dockerAttachExecArgs(containerId: string, env: Record<string, string>): string[] {
  const args = ["exec"];
  for (const [key, value] of Object.entries(env)) args.push("--env", `${key}=${value}`);
  args.push(containerId, "coforge-computer", "__attach-workspace");
  return args;
}

export function dockerNodeStatusArgs(): string[] {
  return ["node", "ls", "--format", "{{.Status}}"];
}

export interface ContainerRuntime {
  findService(computerId: string): Promise<string | undefined>;
  createService(input: {
    computerId: string;
    image: string;
    env: Record<string, string>;
  }): Promise<string>;
  removeService(computerId: string): Promise<void>;
  attachWorkspace(input: { computerId: string; env: Record<string, string> }): Promise<void>;
}

export type DockerSpawn = (
  args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export function createDockerContainers(spawn: DockerSpawn = spawnDocker): ContainerRuntime {
  return {
    async findService(computerId) {
      return firstId(
        await run(spawn, dockerServiceFindArgs(computerId), "docker service ls failed"),
      );
    },
    async createService(input) {
      const result = await run(
        spawn,
        dockerServiceCreateArgs(input),
        "docker service create failed",
      );
      const id = firstId(result);
      if (!id) throw new Error("docker service create returned an empty service id");
      return id;
    },
    async removeService(computerId) {
      const result = await spawn(dockerServiceRemoveArgs(computerId));
      if (result.exitCode !== 0 && !/no such service/i.test(result.stderr))
        throw new Error(result.stderr || "docker service rm failed");
      const volume = await spawn(dockerVolumeRemoveArgs(computerId));
      if (volume.exitCode === 0 || /no such volume/i.test(volume.stderr)) return;
      throw new Error(volume.stderr || "docker volume rm failed");
    },
    async attachWorkspace(input) {
      const containerId = firstId(
        await run(spawn, dockerTaskFindArgs(input.computerId), "docker ps failed"),
      );
      if (!containerId) throw new Error("cloud computer task is not running");
      await run(spawn, dockerAttachExecArgs(containerId, input.env), "docker exec failed");
    },
  };
}

export async function swarmAccepting(spawn: DockerSpawn = spawnDocker): Promise<boolean> {
  const result = await spawn(dockerNodeStatusArgs());
  if (result.exitCode !== 0) return false;
  return result.stdout.split("\n").some((line) => line.trim() === "Ready");
}

async function run(spawn: DockerSpawn, args: string[], fallback: string) {
  const result = await spawn(args);
  if (result.exitCode !== 0) throw new Error(result.stderr || fallback);
  return result;
}

function firstId(result: { stdout: string }): string | undefined {
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

async function spawnDocker(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
