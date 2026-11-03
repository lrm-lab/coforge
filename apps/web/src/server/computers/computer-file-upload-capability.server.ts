import { COMPUTER_FILE_UPLOAD_CAPABILITY } from "@lrm/coforge-sdk/internal";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";
import { RedisComputerCapabilityLease } from "./computer-capability-lease.server";

let singleton: RedisComputerCapabilityLease | undefined;

export function getComputerFileUploadCapabilityLease() {
  return (singleton ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Computer file upload capability leases")),
    COMPUTER_FILE_UPLOAD_CAPABILITY,
    "computer-file-upload-capability",
  ));
}
