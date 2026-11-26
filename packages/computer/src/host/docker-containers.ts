import {
  createDefaultDockerApiClient,
  DockerApiUnavailableError,
  queryContainerInspect,
  queryImageInspect,
  queryLabeledContainers,
  querySwarmAccepting,
  type DockerApiClient,
  type DockerContainerSummary,
} from "./docker-engine-api";

export const COMPUTER_ID_LABEL = "coforge.computer_id";
export const CONTAINER_STATE_MOUNT = "/root/.coforge";
export const CONTAINER_OPT_MOUNT = "/opt";

export function optVolumeName(computerId: string): string {
  return `${serviceName(computerId)}-opt`;
}

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
    "--mount",
    `type=volume,src=${optVolumeName(input.computerId)},dst=${CONTAINER_OPT_MOUNT}`,
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

function resourceGone(stderr: string, resource: "service" | "volume"): boolean {
  return new RegExp(`no such ${resource}|${resource} .+ not found`, "i").test(stderr);
}

function volumeHolders(stderr: string): string[] {
  const match = /volume is in use - \[([^\]]+)\]/i.exec(stderr);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^[0-9a-f]+$/i.test(id));
}

async function removeOneVolume(spawn: DockerSpawn, name: string): Promise<void> {
  const volume = await spawn(["volume", "rm", name]);
  if (volume.exitCode === 0 || resourceGone(volume.stderr, "volume")) return;
  const holders = volumeHolders(volume.stderr);
  if (holders.length === 0) throw new Error(volume.stderr || "docker volume rm failed");
  const cleared = await spawn(["rm", "-f", ...holders]);
  if (cleared.exitCode !== 0) throw new Error(cleared.stderr || "docker rm failed");
  const retry = await spawn(["volume", "rm", name]);
  if (retry.exitCode === 0 || resourceGone(retry.stderr, "volume")) return;
  throw new Error(retry.stderr || "docker volume rm failed");
}

async function removeDisk(spawn: DockerSpawn, computerId: string): Promise<void> {
  await removeOneVolume(spawn, serviceName(computerId));
  await removeOneVolume(spawn, optVolumeName(computerId));
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

export function dockerServiceRestartArgs(computerId: string): string[] {
  return ["service", "update", "--force", serviceName(computerId)];
}

export function dockerServiceImageArgs(computerId: string): string[] {
  return [
    "service",
    "inspect",
    "--format",
    "{{.Spec.TaskTemplate.ContainerSpec.Image}}",
    serviceName(computerId),
  ];
}

export function dockerImageTagArgs(source: string, target: string): string[] {
  return ["tag", source, target];
}

export function dockerActivateRuntimeArgs(containerId: string, version: string): string[] {
  const args = ["exec"];
  const feed = process.env.COFORGE_RELEASE_FEED_URL?.trim();
  if (feed) args.push("-e", `COFORGE_RELEASE_FEED_URL=${feed}`);
  args.push(containerId, "/usr/local/bin/activate-computer-release.sh", version);
  return args;
}

export function dockerRestartRuntimeArgs(containerId: string): string[] {
  return ["exec", containerId, "/usr/local/bin/restart-computer-runtime.sh"];
}

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

export function dockerImageDigestArgs(image: string): string[] {
  return [
    "image",
    "inspect",
    "-f",
    "{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}",
    image,
  ];
}

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function pinnedImageReference(image: string, inspectLine: string): string {
  if (image.includes("@")) return image;
  const token = inspectLine.trim().split(/\s+/)[0] ?? "";
  const digest = token.includes("@") ? token.slice(token.lastIndexOf("@") + 1) : token;
  if (!IMAGE_DIGEST.test(digest)) {
    throw new Error("docker image inspect returned an unusable image id");
  }
  return `${image}@${digest}`;
}

export function stableImageTag(image: string, digest: string): string {
  const named = image.split("@")[0] ?? image;
  const slash = named.lastIndexOf("/");
  const colon = named.lastIndexOf(":");
  const repo = colon > slash ? named.slice(0, colon) : named;
  const hex = digest.replace(/^sha256:/i, "");
  return `${repo}:pinned-${hex.slice(0, 12)}`;
}

export function dockerCloudContainerListArgs(): string[] {
  return ["ps", "-q", "--filter", "label=com.docker.swarm.service.name"];
}

export function dockerCloudPlacementInspectArgs(containerIds: string[]): string[] {
  return [
    "inspect",
    "-f",
    '{{index .Config.Labels "com.docker.swarm.service.name"}} {{.Image}}',
    ...containerIds,
  ];
}

const IMAGE_LAYER = /(?:^|@)(sha256:[0-9a-f]{64})$/i;

export function imageLayerId(reference: string): string | undefined {
  const match = IMAGE_LAYER.exec(reference.trim());
  return match?.[1]?.toLowerCase();
}

export function dockerDesktopInspectArgs(containerId: string): string[] {
  return [
    "inspect",
    "-f",
    '{{range .Config.Env}}{{println .}}{{end}}{{println "---"}}{{range $name, $net := .NetworkSettings.Networks}}{{println $net.IPAddress}}{{end}}',
    containerId,
  ];
}

function tokenFromEnv(lines: string[]): string | undefined {
  let token: string | undefined;
  for (const line of lines) {
    if (!line.startsWith("VNC_WS_TOKEN=")) continue;
    const value = line.slice("VNC_WS_TOKEN=".length).trim();
    if (value) token = value;
  }
  return token;
}

export function parseDesktopInspect(stdout: string): { ip?: string; token?: string } {
  const marker = "\n---\n";
  const at = stdout.indexOf(marker);
  const envText = at === -1 ? stdout : stdout.slice(0, at);
  const ipText = at === -1 ? "" : stdout.slice(at + marker.length);
  const token = tokenFromEnv(envText.split("\n"));
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
  updateServiceImage(computerId: string, image: string): Promise<void>;
  activateRuntime(computerId: string, version: string): Promise<void>;
  inspectPlacement(image: string): Promise<HostImagePlacement>;
  desktopEndpoint(
    computerId: string,
  ): Promise<{ host: string; port: number; token: string } | undefined>;
}

export type DockerSpawn = (
  args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export type DockerContainerOptions = {
  api?: DockerApiClient | null;
};

function resolveRuntimeApi(
  spawn: DockerSpawn | undefined,
  options: DockerContainerOptions | undefined,
): DockerApiClient | undefined {
  if (options && "api" in options) return options.api ?? undefined;
  if (spawn !== undefined) return undefined;
  return createDefaultDockerApiClient();
}

export function createDockerContainers(
  spawn?: DockerSpawn,
  options?: DockerContainerOptions,
): ContainerRuntime {
  const cliSpawn = spawn ?? spawnDocker;
  const api = resolveRuntimeApi(spawn, options);
  return {
    async findService(computerId) {
      return firstId(
        await run(cliSpawn, dockerServiceFindArgs(computerId), "docker service ls failed"),
      );
    },
    async createService(input) {
      const result = await run(
        cliSpawn,
        dockerServiceCreateArgs({
          ...input,
          image: await localImageReference(cliSpawn, input.image),
        }),
        "docker service create failed",
      );
      const id = firstId(result);
      if (!id) throw new Error("docker service create returned an empty service id");
      return id;
    },
    async removeService(computerId) {
      const removed = await cliSpawn(dockerServiceRemoveArgs(computerId));
      if (removed.exitCode !== 0 && !resourceGone(removed.stderr, "service"))
        throw new Error(removed.stderr || "docker service rm failed");
      await removeDisk(cliSpawn, computerId);
    },
    async attachWorkspace(input) {
      const containerId = firstId(
        await run(cliSpawn, dockerTaskFindArgs(input.computerId), "docker ps failed"),
      );
      if (!containerId) throw new Error("cloud computer task is not running");
      await run(cliSpawn, dockerAttachExecArgs(containerId, input.env), "docker exec failed");
    },
    async updateServiceImage(computerId, image) {
      await run(
        cliSpawn,
        dockerServiceUpdateArgs(computerId, await localImageReference(cliSpawn, image)),
        "docker service update failed",
      );
    },
    async activateRuntime(computerId, version) {
      if (
        !/^[A-Za-z0-9.+-]{1,100}$/.test(version) ||
        version === "." ||
        version.startsWith("-") ||
        version.includes("..")
      ) {
        throw new Error("invalid runtime version");
      }
      const recorded = await run(
        cliSpawn,
        dockerServiceImageArgs(computerId),
        "docker service inspect failed",
      );
      await keepPinnedImageTagged(cliSpawn, recorded.stdout);
      const containerId = firstId(
        await run(cliSpawn, dockerTaskFindArgs(computerId), "docker ps failed"),
      );
      if (!containerId) throw new Error("cloud computer task is not running");
      await run(cliSpawn, dockerActivateRuntimeArgs(containerId, version), "docker exec failed");
      const restarted = await cliSpawn(dockerRestartRuntimeArgs(containerId));
      if (restarted.exitCode === 0) return;
      if (runtimeSupervisorMissing(restarted.stderr, restarted.stdout)) {
        await run(cliSpawn, dockerServiceRestartArgs(computerId), "docker service update failed");
        return;
      }
      throw new Error(restarted.stderr || restarted.stdout || "runtime restart failed");
    },
    async desktopEndpoint(computerId) {
      const target = await inspectDesktopTarget(api, cliSpawn, computerId);
      if (!target?.ip) return undefined;
      let token = target.token;
      if (!token) {
        const file = await cliSpawn(["exec", target.containerId, "cat", "/root/.vnc/ws-token.txt"]);
        if (file.exitCode === 0) token = file.stdout.trim();
      }
      return token ? { host: target.ip, port: 6080, token } : undefined;
    },
    async inspectPlacement(image) {
      if (api) {
        try {
          const [inspected, containers] = await Promise.all([
            queryImageInspect(api, image, COMPUTER_VERSION_LABEL),
            queryLabeledContainers(api, "com.docker.swarm.service.name"),
          ]);
          return {
            image: { id: imageLayerId(inspected.id) ?? inspected.id, version: inspected.version },
            computers: placementFromContainers(containers),
          };
        } catch (error) {
          if (!(error instanceof DockerApiUnavailableError)) throw error;
        }
      }
      const inspected = await run(
        cliSpawn,
        dockerImageInspectArgs(image),
        "docker image inspect failed",
      );
      const parsed = parseImageInspect(inspected.stdout);
      if (!parsed) throw new Error("docker image inspect returned an empty image id");
      const list = await cliSpawn(dockerCloudContainerListArgs());
      if (list.exitCode !== 0) throw new Error(list.stderr || "docker ps failed");
      const containerIds = ids(list.stdout);
      if (containerIds.length === 0)
        return {
          image: { id: imageLayerId(parsed.id) ?? parsed.id, version: parsed.version },
          computers: [],
        };
      const details = await run(
        cliSpawn,
        dockerCloudPlacementInspectArgs(containerIds),
        "docker inspect failed",
      );
      return {
        image: { id: imageLayerId(parsed.id) ?? parsed.id, version: parsed.version },
        computers: parsePlacement(details.stdout),
      };
    },
  };
}

async function inspectDesktopTarget(
  api: DockerApiClient | undefined,
  cliSpawn: DockerSpawn,
  computerId: string,
): Promise<{ containerId: string; ip?: string; token?: string } | undefined> {
  if (api) {
    try {
      const listed = await queryLabeledContainers(
        api,
        `com.docker.swarm.service.name=${serviceName(computerId)}`,
      );
      const containerId = listed[0]?.id;
      if (!containerId) return undefined;
      const inspected = await queryContainerInspect(api, containerId);
      return { containerId, ip: inspected.ipAddresses[0], token: tokenFromEnv(inspected.env) };
    } catch (error) {
      if (!(error instanceof DockerApiUnavailableError)) throw error;
    }
  }
  const listed = await cliSpawn(dockerTaskFindArgs(computerId));
  if (listed.exitCode !== 0) throw new Error(listed.stderr || "docker ps failed");
  const containerId = firstId(listed);
  if (!containerId) return undefined;
  const inspected = await cliSpawn(dockerDesktopInspectArgs(containerId));
  if (inspected.exitCode !== 0) throw new Error(inspected.stderr || "docker inspect failed");
  return { containerId, ...parseDesktopInspect(inspected.stdout) };
}

function placementFromContainers(
  containers: DockerContainerSummary[],
): Array<{ computerId: string; imageId: string }> {
  const computers: Array<{ computerId: string; imageId: string }> = [];
  for (const container of containers) {
    const service = container.labels["com.docker.swarm.service.name"];
    if (!service) continue;
    const computerId = computerIdFromServiceName(service);
    const rawImage = container.imageId || container.image;
    const imageId = imageLayerId(rawImage) ?? rawImage;
    if (!computerId || !imageId) continue;
    computers.push({ computerId, imageId });
  }
  return computers;
}

async function localImageReference(spawn: DockerSpawn, image: string): Promise<string> {
  const pinned = image.includes("@")
    ? image
    : pinnedImageReference(
        image,
        (await run(spawn, dockerImageDigestArgs(image), "docker image inspect failed")).stdout,
      );
  await keepPinnedImageTagged(spawn, pinned);
  return pinned;
}

function runtimeSupervisorMissing(stderr: string, stdout: string): boolean {
  const text = `${stderr}\n${stdout}`;
  return /no such file or directory/i.test(text) || /not the runtime supervisor/.test(text);
}

async function keepPinnedImageTagged(spawn: DockerSpawn, image: string): Promise<void> {
  const digest = imageLayerId(image);
  if (!digest) return;
  await run(spawn, dockerImageTagArgs(digest, stableImageTag(image, digest)), "docker tag failed");
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
    const computerId = computerIdFromServiceName(trimmed.slice(0, space));
    const rawImage = trimmed.slice(space + 1).trim();
    const imageId = imageLayerId(rawImage) ?? rawImage;
    if (!computerId || !imageId) continue;
    computers.push({ computerId, imageId });
  }
  return computers;
}

function computerIdFromServiceName(name: string): string | undefined {
  const prefix = "coforge-";
  if (!name.startsWith(prefix)) return undefined;
  const computerId = name.slice(prefix.length);
  return computerId.length > 0 ? computerId : undefined;
}

function ids(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function swarmAccepting(
  spawn?: DockerSpawn,
  options?: DockerContainerOptions,
): Promise<boolean> {
  const api = resolveRuntimeApi(spawn, options);
  if (api) {
    try {
      return await querySwarmAccepting(api);
    } catch (error) {
      if (!(error instanceof DockerApiUnavailableError)) return false;
    }
  }
  const cliSpawn = spawn ?? spawnDocker;
  const result = await cliSpawn(dockerNodeStatusArgs());
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
