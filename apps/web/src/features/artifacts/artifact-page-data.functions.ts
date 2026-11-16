import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workspaceUserMiddleware } from "#src/features/auth/function-auth";
import { declareNoStore } from "#src/features/no-store-response.server";
import { AppError } from "#src/lib/app-error";
import { productionArtifactPage } from "#src/server/artifacts/artifact-composition.server";
import { artifactInputs } from "./artifact-inputs";
import { PAGE_ASSET_MAX_BYTES, PAGE_BATCH_MAX } from "./artifact-page-limits";

const slot = z.string().max(256);
const version = z.number().int().nonnegative().optional();

const write = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("set"),
      collection: slot,
      id: slot,
      data: z.unknown().optional(),
      ifVersion: version,
    })
    .strict(),
  z
    .object({
      op: z.literal("update"),
      collection: slot,
      id: slot,
      data: z.unknown().optional(),
      ifVersion: version,
    })
    .strict(),
  z.object({ op: z.literal("delete"), collection: slot, id: slot, ifVersion: version }).strict(),
]);

const dataCall = z.discriminatedUnion("method", [
  z.object({ method: z.literal("get"), collection: slot, id: slot }).strict(),
  z
    .object({ method: z.literal("query"), collection: slot, query: z.unknown().optional() })
    .strict(),
  z.object({ method: z.literal("write"), writes: z.array(write).max(PAGE_BATCH_MAX) }).strict(),
]);

export const callArtifactPageData = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: artifactInputs.id, call: dataCall }).strict())
  .handler(async ({ context, data }) => {
    declareNoStore();
    const page = productionArtifactPage(context.db).data;
    const viewer = {
      workspaceId: context.workspaceId,
      artifactId: data.artifactId,
      userId: context.user.id,
    };
    const { call } = data;
    if (call.method === "get") return { document: await page.get({ ...viewer, ...call }) };
    if (call.method === "query") return page.query({ ...viewer, ...call });
    return { results: await page.write({ ...viewer, writes: call.writes }) };
  });

const assetCall = z.discriminatedUnion("method", [
  z.object({ method: z.literal("list") }).strict(),
  z.object({ method: z.literal("delete"), name: slot }).strict(),
]);

export const callArtifactPageAssets = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ artifactId: artifactInputs.id, call: assetCall }).strict())
  .handler(async ({ context, data }) => {
    declareNoStore();
    const assets = productionArtifactPage(context.db).assets;
    const viewer = {
      workspaceId: context.workspaceId,
      artifactId: data.artifactId,
      userId: context.user.id,
    };
    if (data.call.method === "list") return { assets: await assets.list(viewer) };
    return assets.delete({ ...viewer, name: data.call.name });
  });

const uploadedFile = z.custom<File>(
  (value) => typeof File !== "undefined" && value instanceof File,
);

export const uploadArtifactPageAsset = createServerFn({ method: "POST" })
  .middleware([workspaceUserMiddleware])
  .validator((data: unknown) => {
    if (!(data instanceof FormData)) throw new AppError("INVALID_INPUT");
    const artifactId = artifactInputs.id.safeParse(data.get("artifactId"));
    const name = slot.safeParse(data.get("name"));
    const file = uploadedFile.safeParse(data.get("file"));
    if (
      !artifactId.success ||
      !name.success ||
      !file.success ||
      file.data.size > PAGE_ASSET_MAX_BYTES
    )
      throw new AppError("INVALID_INPUT");
    return { artifactId: artifactId.data, name: name.data, file: file.data };
  })
  .handler(async ({ context, data }) => {
    declareNoStore();
    return productionArtifactPage(context.db).assets.upload({
      workspaceId: context.workspaceId,
      artifactId: data.artifactId,
      userId: context.user.id,
      name: data.name,
      bytes: new Uint8Array(await data.file.arrayBuffer()),
    });
  });
