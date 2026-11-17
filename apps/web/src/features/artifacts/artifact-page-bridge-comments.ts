import {
  BridgeRefusal,
  INVALID_PARAMS,
  type CallTable,
  type Params,
} from "./artifact-page-bridge-core";
import { commentAnchor, isVisibleText, type PlaceData } from "./artifact-comment-inputs";
import { SUGGESTED_DRAFT_MAX } from "./artifact-page-limits";

export type PageCommentRequest = { anchor: PlaceData; draft?: string };

export type PageSuggestHandler = (request: PageCommentRequest) => boolean;

const refuse = (what: string) => new BridgeRefusal(INVALID_PARAMS, `${what} expected`);

export function parseCommentRequest(args: Params): PageCommentRequest {
  const data = typeof args.anchor === "string" ? { name: args.anchor } : args.anchor;
  const anchor = commentAnchor.safeParse({ type: "page", data });
  if (!anchor.success) throw refuse("A page place");
  const { draft } = args;
  if (draft === undefined || draft === "") return { anchor: anchor.data.data as PlaceData };
  if (
    typeof draft !== "string" ||
    draft.length > SUGGESTED_DRAFT_MAX ||
    !isVisibleText(draft, true)
  )
    throw refuse("A draft");
  return { anchor: anchor.data.data as PlaceData, draft };
}

export function createCommentCalls(host: {
  userActive(): boolean;
  suggestComment: PageSuggestHandler;
}): CallTable {
  return {
    "comments.open": (args) => host.userActive() && host.suggestComment(parseCommentRequest(args)),
  };
}
