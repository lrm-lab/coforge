import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { artifactInputs } from "./artifact-inputs";
import { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";

/**
 * The web page's documents (task #385, the `artifacts` experiment): a document is sent and read
 * as its text. Every call is the signed-in person's, checked by the artifact service against the
 * experiment and the document's home (a conversation, or the Workspace).
 */

const { id, version, text, title, description, note, label, baseVersion } = artifactInputs;

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

/** A new document in a conversation (or the Workspace), named from its title. */
export const createArtifactDocument = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        conversationId: id.optional(),
        title,
        text: text.optional(),
        idempotencyKey: id.optional(),
      })
      .strict(),
  )
  .handler(({ context, data }) =>
    productionArtifacts(context.db).documents.create(scopeOf(context), data),
  );

/**
 * Saves a document over the version the page shows (`baseVersion`). The answer is `created`,
 * `nothing`, or `conflict` (nothing written: the page saves again over `currentVersion`).
 */
export const saveArtifactDocument = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(
    z
      .object({
        artifactId: id,
        baseVersion,
        idempotencyKey: id,
        text: text.optional(),
        title: title.optional(),
        description: description.optional(),
        note: note.optional(),
        label: label.optional(),
      })
      .strict(),
  )
  .handler(({ context, data }) =>
    productionArtifacts(context.db).documents.save(scopeOf(context), data),
  );

/** Moves an artifact between read tiers (task #529): `conversation` keeps it to its home
 * conversation's readers, `workspace` widens it to every Workspace member. Its author, the
 * authoring Agent's owner, or a Workspace owner or admin may; reads never widen writes. */
export const changeArtifactAccess = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id, access: z.enum(["conversation", "workspace"]) }).strict())
  .handler(async ({ context, data }) => {
    await productionArtifacts(context.db).artifacts.changeAccess({
      workspaceId: context.workspaceId,
      artifactId: data.artifactId,
      actor: { userId: context.user.id },
      access: data.access,
    });
    return { access: data.access };
  });

/** Whether an artifact can have a public link, and the one it has (task #646). */
export const loadArtifactLinkSharing = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).publicLinks.read({
      workspaceId: context.workspaceId,
      artifactId: data.artifactId,
      userId: context.user.id,
    }),
  );

export const setArtifactLinkSharing = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: id, enabled: z.boolean() }).strict())
  .handler(({ context, data }) =>
    productionArtifacts(context.db).publicLinks.set({
      workspaceId: context.workspaceId,
      artifactId: data.artifactId,
      userId: context.user.id,
      enabled: data.enabled,
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
