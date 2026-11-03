import type { RedisClient } from "bun";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import type {
  ComputerFileUploadSessionRecord,
  ComputerFileUploadSessions,
} from "./computer-file-upload.server";

const PREFIX = "coforge:computer-file-upload:v1:session";

export class RedisComputerFileUploadSessions implements ComputerFileUploadSessions {
  constructor(private readonly redis: Pick<RedisClient, "get" | "set" | "send">) {}

  private key(uploadId: string) {
    return `${PREFIX}:${uploadId}`;
  }

  async put(session: ComputerFileUploadSessionRecord, ttlSeconds: number) {
    await this.redis.set(
      this.key(session.uploadId),
      JSON.stringify(session),
      "EX",
      String(ttlSeconds),
    );
  }

  async get(uploadId: string) {
    const value = await this.redis.get(this.key(uploadId));
    return value ? (JSON.parse(value) as ComputerFileUploadSessionRecord) : undefined;
  }

  async clear(uploadId: string) {
    await this.redis.send("DEL", [this.key(uploadId)]);
  }
}

let singleton: RedisComputerFileUploadSessions | undefined;

export function getComputerFileUploadSessions() {
  return (singleton ??= new RedisComputerFileUploadSessions(
    openRedisClient(redisUrlFor("Computer file upload sessions")),
  ));
}
