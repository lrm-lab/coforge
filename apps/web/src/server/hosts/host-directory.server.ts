import { timingSafeEqual } from "node:crypto";

export class HostDirectoryError extends Error {
  constructor(
    readonly status: 401 | 409 | 422 | 503,
    message: string,
  ) {
    super(message);
    this.name = "HostDirectoryError";
  }
}

export type ClusterRecord = {
  id: string;
  name: string;
  nodeKey: string | null;
  tokenHash: string;
  lastSeenAt: Date | null;
  accepting: boolean;
};

export type ClusterSnapshot = {
  id: string;
  name: string;
  nodeKey: string;
  accepting: boolean;
  lastSeenAt: string;
};

export interface ClusterStore {
  insert(record: ClusterRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<ClusterRecord | undefined>;
  findByNodeKey(nodeKey: string): Promise<ClusterRecord | undefined>;
  save(record: ClusterRecord): Promise<void>;
}

/** The one Swarm this deployment controls. The token comes from the server environment. */
export class HostDirectory {
  constructor(
    private readonly store: ClusterStore,
    private readonly configuredToken: string | undefined,
  ) {}

  async id(): Promise<string> {
    return (await this.#configuredRecord()).id;
  }

  /** The name and node key already bound to this deployment, for the manager install script. */
  async operatorBinding(): Promise<{ clusterName: string | null; nodeKey: string | null }> {
    const token = configuredSecret(this.configuredToken);
    if (!token) throw new HostDirectoryError(503, "cloud cluster is not configured");
    const existing = await this.store.findByTokenHash(hashSecret(token));
    if (!existing?.nodeKey) return { clusterName: null, nodeKey: null };
    return { clusterName: existing.name, nodeKey: existing.nodeKey };
  }

  async register(input: {
    token: string;
    nodeKey: string;
    name: string;
    now: Date;
  }): Promise<ClusterSnapshot> {
    this.#assertPresented(input.token);
    const record = await this.#configuredRecord();
    const nodeKey = requireToken(input.nodeKey, "invalid node key");
    const name = requireName(input.name);
    if (record.nodeKey === null) {
      const taken = await this.store.findByNodeKey(nodeKey);
      if (taken && taken.id !== record.id) {
        throw new HostDirectoryError(409, "node key already registered");
      }
      record.nodeKey = nodeKey;
    } else if (record.nodeKey !== nodeKey) {
      throw new HostDirectoryError(409, "node key is already bound");
    }
    record.name = name;
    record.lastSeenAt = input.now;
    await this.store.save(record);
    return snapshot(record);
  }

  async heartbeat(input: {
    token: string;
    accepting: boolean;
    now: Date;
  }): Promise<ClusterSnapshot> {
    this.#assertPresented(input.token);
    const record = await this.#configuredRecord();
    if (record.nodeKey === null) throw new HostDirectoryError(422, "host is not registered");
    if (typeof input.accepting !== "boolean") {
      throw new HostDirectoryError(422, "invalid accepting flag");
    }
    record.accepting = input.accepting;
    record.lastSeenAt = input.now;
    await this.store.save(record);
    return snapshot(record);
  }

  async authenticate(token: string): Promise<{ id: string; accepting: boolean } | undefined> {
    const configured = configuredSecret(this.configuredToken);
    if (!configured || !sameSecret(token, configured)) return undefined;
    const record = await this.store.findByTokenHash(hashSecret(configured));
    if (!record?.nodeKey) return undefined;
    return { id: record.id, accepting: record.accepting };
  }

  async #configuredRecord(): Promise<ClusterRecord> {
    const token = configuredSecret(this.configuredToken);
    if (!token) throw new HostDirectoryError(503, "cloud cluster is not configured");
    const tokenHash = hashSecret(token);
    const existing = await this.store.findByTokenHash(tokenHash);
    if (existing) return existing;
    const record: ClusterRecord = {
      id: crypto.randomUUID(),
      name: "cluster",
      nodeKey: null,
      tokenHash,
      lastSeenAt: null,
      accepting: true,
    };
    try {
      await this.store.insert(record);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.store.findByTokenHash(tokenHash);
      if (raced) return raced;
      throw error;
    }
    return record;
  }

  #assertPresented(token: string): void {
    const configured = configuredSecret(this.configuredToken);
    if (!configured || !sameSecret(token, configured)) {
      throw new HostDirectoryError(401, "invalid host token");
    }
  }
}

function snapshot(record: ClusterRecord): ClusterSnapshot {
  if (record.nodeKey === null || record.lastSeenAt === null) {
    throw new HostDirectoryError(422, "host is not registered");
  }
  return {
    id: record.id,
    name: record.name,
    nodeKey: record.nodeKey,
    accepting: record.accepting,
    lastSeenAt: record.lastSeenAt.toISOString(),
  };
}

function configuredSecret(value: string | undefined): string | undefined {
  const token = value?.trim() ?? "";
  if (!token) return undefined;
  if (token.length < 16 || token.length > 200 || /\s/.test(token)) return undefined;
  return token;
}

function requireName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 200) throw new HostDirectoryError(422, "invalid host name");
  return name;
}

function requireToken(value: string, message: string): string {
  const token = value.trim();
  if (!token || token.length > 200 || /\s/.test(token)) throw new HostDirectoryError(422, message);
  return token;
}

function sameSecret(presented: string, configured: string): boolean {
  const left = Buffer.from(hashSecret(presented));
  const right = Buffer.from(hashSecret(configured));
  return left.length === right.length && timingSafeEqual(left, right);
}

function hashSecret(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}
