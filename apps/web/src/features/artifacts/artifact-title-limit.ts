export const ARTIFACT_TITLE_MAX = 300;

export const withinArtifactTitleLimit = (value: string) => [...value].length <= ARTIFACT_TITLE_MAX;
