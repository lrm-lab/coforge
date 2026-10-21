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

export const COMPUTER_VERSION_LABEL = "org.coforge.computer.version";

export function dockerServiceUpdateArgs(computerId: string, image: string): string[] {
  return [
    "service",
    "update",
    "--no-resolve-image",
    "--image",
    image,
    "--force",
    serviceName(computerId),
  ];
}

export function dockerImageInspectArgs(image: string): string[] {
  return [
    "image",
    "inspect",
    "-f",
    `{{.Id}} {{index .Config.Labels "${COMPUTER_VERSION_LABEL}"}}`,
    image,
  ];
}

export function dockerCloudContainerListArgs(): string[] {
  return ["ps", "-q", "--filter", `label=${COMPUTER_ID_LABEL}`];
}

export function dockerCloudPlacementInspectArgs(containerIds: string[]): string[] {
  return [
    "inspect",
    "-f",
    `{{index .Config.Labels "${COMPUTER_ID_LABEL}"}} {{.Image}}`,
    ...containerIds,
  ];
}

export function dockerImageVersionArgs(image: string): string[] {
  return ["run", "--rm", "--network", "none", "--entrypoint", "coforge-computer", image, "-V"];
}

export function dockerDesktopInspectArgs(containerId: string): string[] {
  return [
    "inspect",
    "-f",
    '{{range .Config.Env}}{{println .}}{{end}}{{println "---"}}{{range $name, $net := .NetworkSettings.Networks}}{{println $net.IPAddress}}{{end}}',
    containerId,
  ];
}

export function parseDesktopInspect(stdout: string): { ip?: string; token?: string } {
  const marker = "\n---\n";
  const at = stdout.indexOf(marker);
  const envText = at === -1 ? stdout : stdout.slice(0, at);
  const ipText = at === -1 ? "" : stdout.slice(at + marker.length);
  let token: string | undefined;
  for (const line of envText.split("\n")) {
    if (!line.startsWith("VNC_WS_TOKEN=")) continue;
    const value = line.slice("VNC_WS_TOKEN=".length).trim();
    if (value) token = value;
  }
  const ip = ipText
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return { ip, token };
}

export type HostImagePlacement = {
  image: { id: string; version: string };
  computers: Array<{ computerId: string; imageId: string }>;
};

export interface ContainerRuntime {
  findService(computerId: string): Promise<string | undefined>;
  createService(input: {
    computerId: string;
    image: string;
    env: Record<string, string>;
  }): Promise<string>;
  removeService(computerId: string): Promise<void>;
  attachWorkspace(input: { computerId: string; env: Record<string, string> }): Promise<void>;
  /** Replaces the running image. The named volume stays mounted. */
  updateServiceImage(computerId: string, image: string): Promise<void>;
  inspectPlacement(image: string): Promise<HostImagePlacement>;
  /** Address of the browser desktop inside a running cloud computer. */
  desktopEndpoint(
    computerId: string,
  ): Promise<{ host: string; port: number; token: string } | undefined>;
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
    async updateServiceImage(computerId, image) {
      await run(spawn, dockerServiceUpdateArgs(computerId, image), "docker service update failed");
    },
    async desktopEndpoint(computerId) {
      const listed = await spawn(dockerTaskFindArgs(computerId));
      if (listed.exitCode !== 0) throw new Error(listed.stderr || "docker ps failed");
      const containerId = firstId(listed);
      if (!containerId) return undefined;
      const inspected = await spawn(dockerDesktopInspectArgs(containerId));
      if (inspected.exitCode !== 0) throw new Error(inspected.stderr || "docker inspect failed");
      const parsed = parseDesktopInspect(inspected.stdout);
      if (!parsed.ip) return undefined;
      let token = parsed.token;
      if (!token) {
        const file = await spawn(["exec", containerId, "cat", "/root/.vnc/ws-token.txt"]);
        if (file.exitCode === 0) token = file.stdout.trim();
      }
      if (!token) return undefined;
      return { host: parsed.ip, port: 6080, token };
    },
    async inspectPlacement(image) {
      const inspected = await run(
        spawn,
        dockerImageInspectArgs(image),
        "docker image inspect failed",
      );
      const parsed = parseImageInspect(inspected.stdout);
      if (!parsed) throw new Error("docker image inspect returned an empty image id");
      const version = parsed.version || (await readImageVersion(spawn, image, parsed.id));
      const list = await spawn(dockerCloudContainerListArgs());
      if (list.exitCode !== 0) throw new Error(list.stderr || "docker ps failed");
      const containerIds = ids(list.stdout);
      if (containerIds.length === 0) return { image: { id: parsed.id, version }, computers: [] };
      const details = await run(
        spawn,
        dockerCloudPlacementInspectArgs(containerIds),
        "docker inspect failed",
      );
      return {
        image: { id: parsed.id, version },
        computers: parsePlacement(details.stdout),
      };
    },
  };
}

const imageVersions = new Map<string, string>();

async function readImageVersion(spawn: DockerSpawn, image: string, imageId: string) {
  const cached = imageVersions.get(imageId);
  if (cached) return cached;
  const result = await run(spawn, dockerImageVersionArgs(image), "computer version probe failed");
  const version = result.stdout.trim();
  if (!version) throw new Error("computer version probe returned no version");
  imageVersions.set(imageId, version);
  return version;
}

function parseImageInspect(stdout: string): { id: string; version: string } | undefined {
  const line = stdout.trim();
  if (!line) return undefined;
  const space = line.indexOf(" ");
  if (space < 0) return { id: line, version: "" };
  return { id: line.slice(0, space), version: line.slice(space + 1).trim() };
}

function parsePlacement(stdout: string): Array<{ computerId: string; imageId: string }> {
  const computers: Array<{ computerId: string; imageId: string }> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const space = trimmed.indexOf(" ");
    if (space < 1) continue;
    const computerId = trimmed.slice(0, space);
    const imageId = trimmed.slice(space + 1).trim();
    if (!computerId || !imageId) continue;
    computers.push({ computerId, imageId });
  }
  return computers;
}

function ids(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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
