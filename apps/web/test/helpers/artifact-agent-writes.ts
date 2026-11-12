import type { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";

type Services = ReturnType<typeof productionArtifacts>;

/**
 * What an Agent does to an artifact, for the tests that need artifacts to exist: each file's text
 * is uploaded as the Agent and named in a manifest, as `coforge artifact push` does. A person
 * never writes an artifact, so there is no person's variant.
 */
export function agentWrites(services: Services, workspaceId: string, agentId: string) {
  const scope = { workspaceId, actor: { agentId } };
  const manifest = async (files: Record<string, string>, entryPath?: string) => ({
    files: await Promise.all(
      Object.entries(files).map(async ([path, text]) => ({
        path,
        sha256: (
          await services.blobs.upload({
            workspaceId,
            bytes: new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>,
            actor: { agentId },
          })
        ).sha256,
      })),
    ),
    ...(entryPath ? { entryPath } : {}),
  });
  return {
    /** A new artifact of these files (version 1). */
    create: async (input: {
      conversationId?: string;
      title: string;
      description?: string;
      files: Record<string, string>;
      entry?: string;
    }) => {
      const { files, entry, ...rest } = input;
      return services.documents.create(scope, { ...rest, manifest: await manifest(files, entry) });
    },
    /** A push of these files over `baseVersion`. */
    push: async (artifactId: string, baseVersion: number, files: Record<string, string>) =>
      services.documents.push(scope, {
        artifactId,
        baseVersion,
        idempotencyKey: crypto.randomUUID(),
        manifest: await manifest(files),
      }),
  };
}
