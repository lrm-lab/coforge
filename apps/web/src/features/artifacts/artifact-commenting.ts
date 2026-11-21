import { createContext, useContext } from "react";

import type { AnchorStatus, PublishedPlace } from "./artifact-anchor-places";
import type { CommentAnchor } from "./artifact-comment-inputs";
import type { CommentThread } from "./artifact-comment-threads";
import type { ComposerHolds } from "./artifact-composer-holds";
import type { ArtifactPickBus } from "./artifact-pick-bus";

export type CommentTarget = { version: number; path: string; anchor: CommentAnchor | null };

export type DisplayReportRequest = {
  version?: number | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
};

export type ComposerPrefill = {
  id: number;
  text: string;
};

export type ThreadPlaces = ReadonlyMap<string, PublishedPlace>;

export type ArtifactCommenting = {
  artifactId: string;
  version: number;
  entryPath: string;
  filePaths: readonly string[];
  commenting: boolean;
  panelOpen: boolean;
  revealThread(target: CommentTarget): void;
  openThread(commentId: string): void;
  openPanel(): void;
  publishPlaces(path: string, places: ThreadPlaces | null): void;
  holds: ComposerHolds;
  pickBus: ArtifactPickBus;
};

export type CommentRequests = {
  reveal: CommentTarget | null;
  consumeReveal(): void;
  focus: string | null;
  consumeFocus(): void;
  prefill?: ComposerPrefill | null | undefined;
  consumePrefill?: (() => void) | undefined;
};

export type PublishedPlaces = { path: string; byId: ThreadPlaces } | null;

function required<T>(name: string, value: T | null): T {
  if (value === null) throw new Error(`${name} is missing`);
  return value;
}

export const ArtifactCommentingContext = createContext<ArtifactCommenting | null>(null);
export const ShownThreadsContext = createContext<readonly CommentThread[] | null>(null);
export const CommentRequestsContext = createContext<CommentRequests | null>(null);
export const CommentPlacesContext = createContext<PublishedPlaces>(null);

export const useArtifactCommenting = () =>
  required("ArtifactCommentingContext", useContext(ArtifactCommentingContext));
export const useShownThreads = () =>
  required("ShownThreadsContext", useContext(ShownThreadsContext));
export const useCommentRequests = () =>
  required("CommentRequestsContext", useContext(CommentRequestsContext));
export const useCommentPlaces = () => useContext(CommentPlacesContext);

export function anchorStatus(
  commenting: Pick<ArtifactCommenting, "version">,
  places: PublishedPlaces,
  commentId: string,
  version: number,
): AnchorStatus {
  if (version !== commenting.version) return "elsewhere";
  return places?.byId.get(commentId)?.status ?? "neutral";
}
