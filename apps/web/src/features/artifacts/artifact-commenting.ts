import { createContext, useContext } from "react";

import type { AnchorPlace, AnchorStatus } from "./artifact-anchor-places";
import type { CommentAnchor } from "./artifact-comment-inputs";
import type { CommentThread } from "./artifact-comment-threads";

export type CommentTarget = { path: string; anchor: CommentAnchor | null };

export type ThreadPlaces = ReadonlyMap<string, AnchorPlace>;

export type ArtifactCommenting = {
  artifactId: string;
  version: number;
  entryPath: string;
  filePaths: readonly string[];
  commenting: boolean;
  panelOpen: boolean;
  revealThread(target: CommentTarget): void;
  openThread(commentId: string): void;
  publishPlaces(path: string, places: ThreadPlaces | null): void;
};

export type CommentRequests = {
  reveal: CommentTarget | null;
  consumeReveal(): void;
  focus: string | null;
  consumeFocus(): void;
};

export type PublishedPlaces = { path: string; byId: ThreadPlaces } | null;

function required<T>(name: string, value: T | null): T {
  if (value === null) throw new Error(`${name} is missing`);
  return value;
}

export const ArtifactCommentingContext = createContext<ArtifactCommenting | null>(null);
export const CommentThreadsContext = createContext<readonly CommentThread[] | null>(null);
export const CommentRequestsContext = createContext<CommentRequests | null>(null);
export const CommentPlacesContext = createContext<PublishedPlaces>(null);

export const useArtifactCommenting = () =>
  required("ArtifactCommentingContext", useContext(ArtifactCommentingContext));
export const useCommentThreads = () =>
  required("CommentThreadsContext", useContext(CommentThreadsContext));
export const useCommentRequests = () =>
  required("CommentRequestsContext", useContext(CommentRequestsContext));
export const useCommentPlaces = () => useContext(CommentPlacesContext);

export const artifactHasFile = (
  { entryPath, filePaths }: Pick<ArtifactCommenting, "entryPath" | "filePaths">,
  path: string,
) => path === entryPath || filePaths.includes(path);

export function anchorStatus(
  commenting: Pick<ArtifactCommenting, "entryPath" | "filePaths">,
  places: PublishedPlaces,
  commentId: string,
  path: string,
): AnchorStatus {
  if (!artifactHasFile(commenting, path)) return "missing";
  return places?.byId.get(commentId)?.status ?? "neutral";
}
