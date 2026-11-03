import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";

/**
 * The web page's documents (task #385, the `artifacts` experiment): a document is sent and read
 * as its text. Every call is the signed-in person's, checked by the artifact service against the
 * experiment and the document's home (a conversation, or the Workspace).
 */

const id = z.uuid();
const version = z.number().int().positive();
/** A document's text: at most 2 MiB once encoded, which the service checks in bytes, and no
 * NUL, which would store it as binary. */
const text = z
  .string()
  .max(2 * 1024 * 1024)
  .refine((value) => !value.includes("\u0000"));

const scopeOf = (context: { workspaceId: string; user: { id: string } }) => ({
  workspaceId: context.workspaceId,
  actor: { userId: context.user.id },
});

/** The documents of a conversation, or of the Workspace when none is named, newest first. */
export const listArtifacts = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ conversationId: id.optional() }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).documents.list(scopeOf(context), data),
  );

/** Cards (title, preview, version) of documents a message names; unreadable ones are left out. */
export const loadArtifactCards = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactIds: z.array(id).min(1).max(100) }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).documents.cards(scopeOf(context), data.artifactIds),
  );

/** A document at a version (the current one by default), with its text. */
export const loadArtifactDocument = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id, version: version.optional() }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).documents.load(scopeOf(context), data),
  );

/** A document's versions, newest first; `before` is the previous page's `nextBefore`. */
export const loadArtifactHistory = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        artifactId: id,
        before: version.optional(),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
  )
  .handler(({ context, data }) =>
    productionArtifacts(context.db).artifacts.history({
      workspaceId: context.workspaceId,
      reader: { userId: context.user.id },
      ...data,
    }),
  );

/** A new document in a conversation (or the Workspace), named from its title. */
export const createArtifactDocument = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        conversationId: id.optional(),
        title: z.string().trim().min(1).max(200),
        text: text.optional(),
      })
      .strict(),
  )
  .handler(({ context, data }) =>
    productionArtifacts(context.db).documents.create(scopeOf(context), data),
  );

/**
 * Saves a document over the version the page shows (`baseVersion`). The answer is `created`,
 * `nothing`, or `conflict` (nothing written: resolve, then save over `currentVersion`).
 */
export const saveArtifactDocument = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        artifactId: id,
        baseVersion: z.number().int().nonnegative(),
        idempotencyKey: id,
        text: text.optional(),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(1000).optional(),
        note: z.string().max(500).optional(),
        label: z.string().max(60).optional(),
      })
      .strict(),
  )
  .handler(({ context, data }) =>
    productionArtifacts(context.db).documents.save(scopeOf(context), data),
  );

/** Goes back to version `to`: saved as a new version over `baseVersion`, which must be current. */
export const revertArtifact = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z.object({ artifactId: id, to: version, baseVersion: version, idempotencyKey: id }).strict(),
  )
  .handler(({ context, data }) =>
    productionArtifacts(context.db).documents.revert({
      workspaceId: context.workspaceId,
      actor: { userId: context.user.id },
      ...data,
    }),
  );

/** Deletes a document: its author's, or a Workspace owner's or admin's. */
export const deleteArtifact = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id }).strict())
  .handler(async ({ context, data }) => {
    await productionArtifacts(context.db).artifacts.delete({
      workspaceId: context.workspaceId,
      artifactId: data.artifactId,
      actor: { userId: context.user.id },
    });
    return { deleted: true as const };
  });
