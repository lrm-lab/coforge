import { cloudImageOfferLabel, sameImageLayer } from "#src/features/computers/cloud-image-update";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";

export type CloudImageSnapshot = {
  image: { id: string; version: string };
  computers: Array<{ computerId: string; imageId: string }>;
};

export type CloudImageUpdate = {
  imageId: string;
  version: string;
};

const KEY = "coforge:cloud-image:v1";
const TTL_SECONDS = 90;

/** Reads the optional image report on a host heartbeat. Missing or malformed fields are ignored. */
export function parseHostImageReport(
  body: Record<string, unknown>,
): CloudImageSnapshot | undefined {
  const image = body.image;
  if (!image || typeof image !== "object" || Array.isArray(image)) return undefined;
  const id = text((image as Record<string, unknown>).id);
  if (!id) return undefined;
  const version = text((image as Record<string, unknown>).version) ?? "";
  const computers: CloudImageSnapshot["computers"] = [];
  if (Array.isArray(body.computers)) {
    for (const item of body.computers) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const computerId = text(row.computerId);
      const imageId = text(row.imageId);
      if (!computerId || !imageId) continue;
      computers.push({ computerId, imageId });
    }
  }
  return { image: { id, version }, computers };
}

export function cloudImageUpdateFor(
  snapshot: CloudImageSnapshot,
  computerId: string,
): CloudImageUpdate | undefined {
  const running = snapshot.computers.find((computer) => computer.computerId === computerId);
  if (!running || sameImageLayer(running.imageId, snapshot.image.id)) return undefined;
  return { imageId: snapshot.image.id, version: cloudImageOfferLabel(snapshot.image) };
}

export class CloudImageInventory {
  constructor(
    private readonly redis: {
      get(key: string): Promise<string | null>;
      set(...args: string[]): Promise<unknown>;
    },
  ) {}

  async replace(snapshot: CloudImageSnapshot): Promise<void> {
    await this.redis.set(KEY, JSON.stringify(snapshot), "EX", String(TTL_SECONDS));
  }

  async snapshot(): Promise<CloudImageSnapshot | undefined> {
    const raw = await this.redis.get(KEY);
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as CloudImageSnapshot;
      if (!text(value?.image?.id) || !Array.isArray(value.computers)) return undefined;
      return {
        image: { id: value.image.id.trim(), version: value.image.version?.trim() ?? "" },
        computers: value.computers,
      };
    } catch {
      return undefined;
    }
  }

  async available(computerId: string): Promise<CloudImageUpdate | undefined> {
    const current = await this.snapshot();
    return current ? cloudImageUpdateFor(current, computerId) : undefined;
  }

  async availableMany(computerIds: readonly string[]): Promise<Map<string, CloudImageUpdate>> {
    const current = await this.snapshot();
    const found = new Map<string, CloudImageUpdate>();
    if (!current) return found;
    for (const computerId of computerIds) {
      const update = cloudImageUpdateFor(current, computerId);
      if (update) found.set(computerId, update);
    }
    return found;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

let singleton: CloudImageInventory | undefined;
export function getCloudImageInventory() {
  const url = redisUrlFor("cloud computer image");
  singleton ??= new CloudImageInventory(openRedisClient(url));
  return singleton;
}
