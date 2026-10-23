import {
  cloudComputerImage,
  imageLayerId,
  type CloudComputerImage,
} from "#src/features/computers/cloud-image-update";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";

export type CloudImageSnapshot = {
  image: { id: string; version: string };
  computers: Array<{ computerId: string; imageId: string; retained?: boolean }>;
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
  return cloudComputerImage(snapshot, computerId)?.update;
}

export class CloudImageInventory {
  constructor(
    private readonly redis: {
      get(key: string): Promise<string | null>;
      set(...args: string[]): Promise<unknown>;
    },
    private readonly retainedImages: ReadonlySet<string> = new Set(),
  ) {}

  async replace(snapshot: CloudImageSnapshot): Promise<void> {
    await this.redis.set(
      KEY,
      JSON.stringify({ ...snapshot, observedAt: Date.now() }),
      "EX",
      String(TTL_SECONDS),
    );
  }

  async snapshot(): Promise<CloudImageSnapshot | undefined> {
    const raw = await this.redis.get(KEY);
    if (!raw) return undefined;
    try {
      const value = JSON.parse(raw) as CloudImageSnapshot;
      if (!text(value?.image?.id) || !Array.isArray(value.computers)) return undefined;
      return {
        image: { id: value.image.id.trim(), version: value.image.version?.trim() ?? "" },
        computers: value.computers.map(({ computerId, imageId }) => ({
          computerId,
          imageId,
          ...(this.retainedImages.has(imageLayerId(imageId) ?? imageId) ? { retained: true } : {}),
        })),
      };
    } catch {
      return undefined;
    }
  }

  /** A queued shared replace must still be safe when the host asks to execute it. */
  async replacementPolicy(computerId: string): Promise<"allow" | "retain" | "unknown"> {
    const current = await this.snapshot();
    const running = current?.computers.find((computer) => computer.computerId === computerId);
    return !running ? "unknown" : running.retained ? "retain" : "allow";
  }

  async available(computerId: string): Promise<CloudImageUpdate | undefined> {
    const current = await this.snapshot();
    return current ? cloudImageUpdateFor(current, computerId) : undefined;
  }

  async images(computerIds: readonly string[]): Promise<Map<string, CloudComputerImage>> {
    const current = await this.snapshot();
    const found = new Map<string, CloudComputerImage>();
    if (!current) return found;
    for (const computerId of computerIds) {
      const image = cloudComputerImage(current, computerId);
      if (image) found.set(computerId, image);
    }
    return found;
  }
}

/** A durable operator hold for images containing local customizations. Empty leaves ordinary updates unchanged. */
export function readRetainedCloudImageIds(value: string | undefined): ReadonlySet<string> {
  const ids = value?.trim() ? value.trim().split(/[,\s]+/) : [];
  if (ids.length > 1000 || ids.some((id) => !/^sha256:[0-9a-f]{64}$/i.test(id)))
    throw new Error("COFORGE_RETAINED_CLOUD_IMAGE_IDS must contain exact sha256 image IDs");
  return new Set(ids.map((id) => id.toLowerCase()));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

let singleton: CloudImageInventory | undefined;
export function getCloudImageInventory() {
  const url = redisUrlFor("cloud computer image");
  singleton ??= new CloudImageInventory(
    openRedisClient(url),
    readRetainedCloudImageIds(process.env.COFORGE_RETAINED_CLOUD_IMAGE_IDS),
  );
  return singleton;
}

/** Host snapshot rows for cloud computers in a workspace list, or none when the ids are empty. */
export async function readCloudComputerImages(
  computerIds: readonly string[],
): Promise<Map<string, CloudComputerImage>> {
  if (computerIds.length === 0) return new Map();
  return getCloudImageInventory()
    .images(computerIds)
    .catch(() => new Map());
}
