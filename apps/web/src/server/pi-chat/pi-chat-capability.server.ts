import {
  PI_CHAT_CAPABILITY,
  PI_CHAT_CONTROLS_CAPABILITY,
  PI_CHAT_FILES_CAPABILITY,
} from "@lrm/coforge-sdk/internal/pi-chat-wire";
import { RedisComputerCapabilityLease } from "#src/server/computers/computer-capability-lease.server";
import { openRedisClient } from "#src/server/redis-client.server";
import { redisUrlFor } from "#src/server/redis-url.server";

let lease: RedisComputerCapabilityLease | undefined;
let controls: RedisComputerCapabilityLease | undefined;
let files: RedisComputerCapabilityLease | undefined;
export function getPiChatFilesLease() {
  return (files ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Pi chat files")),
    PI_CHAT_FILES_CAPABILITY,
    "pi-chat-files",
  ));
}
export function getPiChatControlsLease() {
  return (controls ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Pi chat controls")),
    PI_CHAT_CONTROLS_CAPABILITY,
    "pi-chat-controls",
  ));
}
export function getPiChatCapabilityLease() {
  return (lease ??= new RedisComputerCapabilityLease(
    openRedisClient(redisUrlFor("Pi chat capability leases")),
    PI_CHAT_CAPABILITY,
    "pi-chat-capability",
  ));
}
