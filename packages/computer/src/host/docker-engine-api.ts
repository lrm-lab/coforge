export const DEFAULT_DOCKER_SOCKET_PATH = "/var/run/docker.sock";

const DOCKER_API_TIMEOUT_MS = 15_000;

export type DockerApiResponse = {
  status: number;
  body: unknown;
  message?: string;
};

export interface DockerApiClient {
  getJson(path: string): Promise<DockerApiResponse>;
}

export type DockerContainerSummary = {
  id: string;
  image: string;
  imageId: string;
  labels: Record<string, string>;
};

export type DockerContainerInspect = {
  env: string[];
  ipAddresses: string[];
};

export class DockerApiUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DockerApiUnavailableError";
  }
}

export function resolveDockerUnixSocketPath(
  env: Record<string, string | undefined> = Bun.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform === "win32") return undefined;
  const context = env.DOCKER_CONTEXT?.trim();
  if (context && context !== "default") return undefined;
  if (env.DOCKER_TLS_VERIFY) return undefined;
  const host = env.DOCKER_HOST?.trim();
  if (!host) return DEFAULT_DOCKER_SOCKET_PATH;
  if (!host.startsWith("unix://")) return undefined;
  const socketPath = host.slice("unix://".length).trim();
  return socketPath.length > 0 ? socketPath : undefined;
}

export function createDefaultDockerApiClient(
  env: Record<string, string | undefined> = Bun.env,
  platform: NodeJS.Platform = process.platform,
): DockerApiClient | undefined {
  const socketPath = resolveDockerUnixSocketPath(env, platform);
  return socketPath ? createUnixDockerApiClient(socketPath) : undefined;
}

export function createUnixDockerApiClient(socketPath: string): DockerApiClient {
  return {
    async getJson(path: string): Promise<DockerApiResponse> {
      let response: Response;
      try {
        response = await fetch(`http://localhost${path}`, {
          unix: socketPath,
          signal: AbortSignal.timeout(DOCKER_API_TIMEOUT_MS),
        });
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError")
        ) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new DockerApiUnavailableError(message, { cause: error });
      }
      const text = await response.text();
      if (!text) {
        return { status: response.status, body: undefined };
      }
      try {
        const body: unknown = JSON.parse(text);
        return { status: response.status, body, message: extractErrorMessage(body) };
      } catch {
        return { status: response.status, body: undefined, message: text.trim() || undefined };
      }
    },
  };
}

export async function querySwarmAccepting(api: DockerApiClient): Promise<boolean> {
  const res = await api.getJson("/nodes");
  if (res.status !== 200 || !Array.isArray(res.body)) return false;
  return res.body.some((node) => isReadyNode(node));
}

export async function queryImageInspect(
  api: DockerApiClient,
  image: string,
  versionLabel: string,
): Promise<{ id: string; version: string }> {
  const res = await api.getJson(`/images/${encodeURIComponent(image)}/json`);
  if (res.status !== 200) throw new Error(res.message || "docker image inspect failed");
  const record = asRecord(res.body);
  const id = typeof record?.Id === "string" ? record.Id.trim() : "";
  if (!id) throw new Error("docker image inspect returned an empty image id");
  const config = asRecord(record?.Config);
  const labels = asRecord(config?.Labels);
  const rawVersion = labels?.[versionLabel];
  const version = typeof rawVersion === "string" ? rawVersion.trim() : "";
  return { id, version };
}

export async function queryLabeledContainers(
  api: DockerApiClient,
  labelFilter: string,
): Promise<DockerContainerSummary[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [labelFilter] }));
  const res = await api.getJson(`/containers/json?filters=${filters}`);
  if (res.status !== 200 || !Array.isArray(res.body)) {
    throw new Error(res.message || "docker ps failed");
  }
  const containers: DockerContainerSummary[] = [];
  for (const item of res.body) {
    const record = asRecord(item);
    if (!record) continue;
    const id = typeof record.Id === "string" ? record.Id.trim() : "";
    if (!id) continue;
    const image = typeof record.Image === "string" ? record.Image.trim() : "";
    const imageId = typeof record.ImageID === "string" ? record.ImageID.trim() : "";
    const labels: Record<string, string> = {};
    const rawLabels = asRecord(record.Labels);
    if (rawLabels) {
      for (const [key, value] of Object.entries(rawLabels)) {
        if (typeof value === "string") labels[key] = value;
      }
    }
    containers.push({ id, image, imageId, labels });
  }
  return containers;
}

export async function queryContainerInspect(
  api: DockerApiClient,
  containerId: string,
): Promise<DockerContainerInspect> {
  const res = await api.getJson(`/containers/${encodeURIComponent(containerId)}/json`);
  if (res.status !== 200) throw new Error(res.message || "docker inspect failed");
  const record = asRecord(res.body);
  const config = asRecord(record?.Config);
  const env: string[] = [];
  if (Array.isArray(config?.Env)) {
    for (const entry of config.Env) {
      if (typeof entry === "string") env.push(entry);
    }
  }
  const ipAddresses: string[] = [];
  const networkSettings = asRecord(record?.NetworkSettings);
  const networks = asRecord(networkSettings?.Networks);
  if (networks) {
    for (const value of Object.values(networks)) {
      const network = asRecord(value);
      const ip = typeof network?.IPAddress === "string" ? network.IPAddress.trim() : "";
      if (ip.length > 0) ipAddresses.push(ip);
    }
  }
  return { env, ipAddresses };
}

function isReadyNode(value: unknown): boolean {
  const node = asRecord(value);
  const status = asRecord(node?.Status);
  return typeof status?.State === "string" && status.State.trim().toLowerCase() === "ready";
}

function extractErrorMessage(body: unknown): string | undefined {
  const record = asRecord(body);
  const message = record?.message;
  return typeof message === "string" && message.trim().length > 0 ? message.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
