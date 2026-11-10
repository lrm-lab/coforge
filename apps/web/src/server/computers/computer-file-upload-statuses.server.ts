import type { RedisClient } from "bun";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { workspaceRedisKey } from "#src/server/redis-keys.server";
import type {
  ComputerFileUploadOutcome,
  ComputerFileUploadScope,
  ComputerFileUploadStatus,
  ComputerFileUploadStatuses,
} from "./computer-file-upload.server";

// One atomic step, so a renewal can neither overwrite an outcome nor shorten its lifetime: a
// missing record becomes pending again (it expired while the upload was alive), a pending one is
// extended, and one that holds an outcome is left alone.
const RENEW = `local current = redis.call('GET', KEYS[1])
if not current then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
elseif not string.find(current, '"outcome"', 1, true) then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 1`;

export class RedisComputerFileUploadStatuses implements ComputerFileUploadStatuses {
  constructor(private readonly redis: Pick<RedisClient, "get" | "set" | "send">) {}

  private key(scope: ComputerFileUploadScope, uploadId: string) {
    const prefix = workspaceRedisKey({ ...scope, name: "computer-file-upload", version: "v1" });
    return `${prefix}:${encodeURIComponent(uploadId)}`;
  }

  private async write(
    scope: ComputerFileUploadScope,
    uploadId: string,
    status: ComputerFileUploadStatus,
    ttlSeconds: number,
  ) {
    await this.redis.set(
      this.key(scope, uploadId),
      JSON.stringify(status),
      "EX",
      String(ttlSeconds),
    );
  }

  begin(scope: ComputerFileUploadScope, uploadId: string, userId: string, leaseSeconds: number) {
    return this.write(scope, uploadId, { userId }, leaseSeconds);
  }

  async renew(
    scope: ComputerFileUploadScope,
    uploadId: string,
    userId: string,
    leaseSeconds: number,
  ) {
    await this.redis.send("EVAL", [
      RENEW,
      "1",
      this.key(scope, uploadId),
      JSON.stringify({ userId } satisfies ComputerFileUploadStatus),
      String(leaseSeconds),
    ]);
  }

  settle(
    scope: ComputerFileUploadScope,
    uploadId: string,
    userId: string,
    outcome: ComputerFileUploadOutcome,
    ttlSeconds: number,
  ) {
    return this.write(scope, uploadId, { userId, outcome }, ttlSeconds);
  }

  async read(scope: ComputerFileUploadScope, uploadId: string) {
    const value = await this.redis.get(this.key(scope, uploadId));
    if (!value) return undefined;
    try {
      return JSON.parse(value) as ComputerFileUploadStatus;
    } catch {
      return undefined;
    }
  }
}

let singleton: RedisComputerFileUploadStatuses | undefined;

export function getComputerFileUploadStatuses() {
  return (singleton ??= new RedisComputerFileUploadStatuses(
    openRedisClient(redisUrlFor("Computer file upload statuses")),
  ));
}
