type ArtifactPageModule = typeof import("./artifact-page");

let pending: Promise<ArtifactPageModule> | undefined;
let loaded: ArtifactPageModule["ArtifactPage"] | undefined;

export function getLoadedArtifactPage() {
  return loaded;
}

export function preloadArtifactPage() {
  pending ??= import("./artifact-page")
    .then((mod) => {
      loaded = mod.ArtifactPage;
      return mod;
    })
    .catch((error) => {
      pending = undefined;
      throw error;
    });
  return pending;
}

export function clearArtifactPagePreload() {
  pending = undefined;
  loaded = undefined;
}
