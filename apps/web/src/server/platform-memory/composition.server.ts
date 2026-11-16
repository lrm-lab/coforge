import { readFile } from "node:fs/promises";
import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaPlatformMemoryStore } from "#src/server/db/repositories/platform-memory.repositories.server";
import { decodePlatformMemoryCommand, type PlatformMemoryResult } from "@lrm/coforge-sdk/agent";
import { AppError } from "#src/lib/app-error";
import { MemoryError, type MemoryActor } from "./contract";
import { PlatformMemory } from "./memory";
import { OpenVikingMemoryEngine, type MemoryRuntimeBinding } from "./openviking-engine.server";

export function platformMemory(db: PrismaClient) {
  const resolveBinding = async (workspaceId: string): Promise<MemoryRuntimeBinding> => {
    const baseUrl = Bun.env.COFORGE_OPENVIKING_URL;
    const path = Bun.env.COFORGE_OPENVIKING_ACCOUNT_KEYS_FILE;
    if (!baseUrl || !path) throw new MemoryError("unavailable");
    const binding = await db.openVikingBinding.findUnique({
      where: { workspaceId },
      select: { credentialRef: true, accountId: true },
    });
    if (!binding) throw new MemoryError("unavailable");
    const keys: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!keys || typeof keys !== "object" || !(binding.credentialRef in keys))
      throw new MemoryError("unavailable");
    const token = (keys as Record<string, unknown>)[binding.credentialRef];
    if (typeof token !== "string" || token.length === 0) throw new MemoryError("unavailable");
    return { baseUrl, token, accountId: binding.accountId, userId: "coforge-platform-memory" };
  };
  const bindings = new Map<string, Promise<MemoryRuntimeBinding>>();
  const engine = new OpenVikingMemoryEngine((workspaceId) => {
    let binding = bindings.get(workspaceId);
    if (!binding) {
      binding = resolveBinding(workspaceId);
      bindings.set(workspaceId, binding);
    }
    return binding;
  });
  return new PlatformMemory(new PrismaPlatformMemoryStore(db), engine);
}
export async function runPlatformMemory(
  db: PrismaClient,
  actor: MemoryActor,
  value: unknown,
): Promise<PlatformMemoryResult> {
  let command;
  try {
    command = decodePlatformMemoryCommand(value);
  } catch {
    throw new AppError("INVALID_INPUT");
  }
  try {
    return await platformMemory(db).execute(actor, command);
  } catch (error) {
    if (error instanceof MemoryError) {
      if (error.code === "not_found") throw new AppError("NOT_FOUND");
      if (error.code === "forbidden" || error.code === "disabled")
        throw new AppError("ACCESS_DENIED");
      if (error.code === "conflict") throw new AppError("CONFLICT");
      if (error.code === "invalid") throw new AppError("INVALID_INPUT");
    }
    throw new AppError("TEMPORARILY_UNAVAILABLE");
  }
}
