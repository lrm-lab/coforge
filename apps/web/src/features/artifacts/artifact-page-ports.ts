import { isAppError } from "#src/lib/app-error";
import { PageHostError, type PageAssetsPort, type PageDataPort } from "./artifact-page-bridge";
import { artifactDataEvents } from "./artifact-page-data-events";
import {
  callArtifactPageAssets,
  callArtifactPageData,
  uploadArtifactPageAsset,
} from "./artifact-page-data.functions";

async function asked<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (cause) {
    throw new PageHostError(
      isAppError(cause) ? (cause.errorId ?? cause.code.toLowerCase()) : "failed",
    );
  }
}

export const pageDataPort = (artifactId: string): PageDataPort => ({
  call: (call) => asked(callArtifactPageData({ data: { artifactId, call } })),
  subscribe: (listener) =>
    artifactDataEvents.subscribe((event) => {
      if (event.artifactId === artifactId) listener(event.collection);
    }),
});

export const pageAssetsPort = (artifactId: string): PageAssetsPort => ({
  list: () => asked(callArtifactPageAssets({ data: { artifactId, call: { method: "list" } } })),
  delete: (name) =>
    asked(callArtifactPageAssets({ data: { artifactId, call: { method: "delete", name } } })),
  upload: (file, name) => {
    const form = new FormData();
    form.set("artifactId", artifactId);
    form.set("name", name);
    form.set("file", file, name);
    return asked(uploadArtifactPageAsset({ data: form }));
  },
});
