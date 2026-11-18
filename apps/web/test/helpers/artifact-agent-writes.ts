import type { productionArtifacts } from "#src/server/artifacts/artifact-composition.server";

type Services = ReturnType<typeof productionArtifacts>;

export function agentWrites(services: Services, workspaceId: string, agentId: string) {
  const scope = { workspaceId, actor: { agentId } };
  const manifest = async (files: Record<string, string | Uint8Array>, entryPath?: string) => ({
    files: await Promise.all(
      Object.entries(files).map(async ([path, content]) => ({
        path,
        sha256: (
          await services.blobs.upload({
            workspaceId,
            bytes: (typeof content === "string"
              ? new TextEncoder().encode(content)
              : content) as Uint8Array<ArrayBuffer>,
            actor: { agentId },
          })
        ).sha256,
      })),
    ),
    ...(entryPath ? { entryPath } : {}),
  });
  return {
    create: async (input: {
      conversationId: string;
      title: string;
      description?: string;
      files: Record<string, string | Uint8Array>;
      entry?: string;
    }) => {
      const { files, entry, ...rest } = input;
      return services.documents.create(scope, { ...rest, manifest: await manifest(files, entry) });
    },
    push: async (
      artifactId: string,
      baseVersion: number,
      files: Record<string, string>,
      entry?: string,
    ) =>
      services.documents.push(scope, {
        artifactId,
        baseVersion,
        idempotencyKey: crypto.randomUUID(),
        manifest: await manifest(files, entry),
      }),
  };
}
