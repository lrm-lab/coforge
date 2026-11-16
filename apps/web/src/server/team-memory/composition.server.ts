import type { PrismaClient } from "#src/generated/prisma/client";
import { PrismaTeamMemoryStore } from "#src/server/db/repositories/team-memory.repositories.server";
import { TeamMemory } from "./memory";

export function teamMemory(db: PrismaClient): TeamMemory {
  return new TeamMemory(new PrismaTeamMemoryStore(db));
}
