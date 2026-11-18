import type { DatabaseScope } from "#src/server/db/transaction.server";
import { PrismaTeamMemoryStore } from "#src/server/db/repositories/team-memory.repositories.server";
import { TeamMemory } from "./memory";

export function teamMemory(db: DatabaseScope): TeamMemory {
  return new TeamMemory(new PrismaTeamMemoryStore(db));
}
