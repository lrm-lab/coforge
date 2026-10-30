import type { PrismaClient } from "#src/generated/prisma/client";
import type { DirectConversationRepository } from "#src/server/db/repositories/direct-conversation.repositories.server";

/** A repository fake's `database` for a test that does not look at what a message announces: any
 * read of it throws, which the announcement logs as `conversation_realtime:message_failed`. */
export const unusedDatabase = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`this fake repository has no database (read ${String(property)})`);
    },
  },
) as PrismaClient;

/** A direct conversation repository fake, which `withUnusedDatabase` completes. */
export type RepositoryFake = Omit<DirectConversationRepository, "database">;

/** `repository`, given `unusedDatabase`. */
export const withUnusedDatabase = (repository: RepositoryFake): DirectConversationRepository =>
  Object.assign(repository, { database: unusedDatabase });
