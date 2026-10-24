import type { AgentMessageRecord } from "@lrm/coforge-sdk/internal";
import { fenceMessageBody } from "./message-body-format";
import {
  formatLocalTimeWithOffset,
  messageSender,
  neutralizeReferenceLiterals,
  taskSuffix,
} from "./message-format";

function indexOfCaseInsensitive(haystack: string, needle: string): number {
  if (!needle) return -1;
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

function firstQueryTerm(query: string): string {
  const trimmed = query.trim();
  const match = /^"([^"]*)"|^(\S+)/.exec(trimmed);
  if (!match) return "";
  return (match[1] ?? match[2] ?? "").trim();
}

const PREVIEW_LEADING_CONTEXT = 80;
const PREVIEW_TRAILING_CONTEXT = 120;
const PREVIEW_NO_MATCH_LENGTH = 200;

export function renderSearchPreview(body: string, query: string): string {
  const trimmedQuery = query.trim();
  let matchStart = -1;
  let matchLength = 0;

  if (trimmedQuery) {
    const index = indexOfCaseInsensitive(body, trimmedQuery);
    if (index >= 0) {
      matchStart = index;
      matchLength = trimmedQuery.length;
    }
  }
  if (matchStart < 0) {
    const term = firstQueryTerm(query);
    if (term) {
      const index = indexOfCaseInsensitive(body, term);
      if (index >= 0) {
        matchStart = index;
        matchLength = term.length;
      }
    }
  }

  const hasMatch = matchStart >= 0;
  const matchEnd = matchStart + matchLength;
  const windowStart = hasMatch ? Math.max(0, matchStart - PREVIEW_LEADING_CONTEXT) : 0;
  const windowEnd = hasMatch
    ? Math.min(body.length, matchEnd + PREVIEW_TRAILING_CONTEXT)
    : Math.min(body.length, PREVIEW_NO_MATCH_LENGTH);
  const cutStart = hasMatch && windowStart > 0;
  const cutEnd = windowEnd < body.length;

  let pre = hasMatch ? body.slice(windowStart, matchStart) : "";
  const matched = hasMatch ? body.slice(matchStart, matchEnd) : "";
  let post = hasMatch ? body.slice(matchEnd, windowEnd) : body.slice(windowStart, windowEnd);

  if (cutStart) pre = pre.trimStart();
  if (cutEnd) post = post.trimEnd();

  const safePre = neutralizeReferenceLiterals(pre);
  const safeMatched = neutralizeReferenceLiterals(matched);
  const safePost = neutralizeReferenceLiterals(post);
  const core = hasMatch ? `${safePre}<match>${safeMatched}</match>${safePost}` : safePost;

  return `${cutStart ? "<omit />" : ""}${core}${cutEnd ? "<omit />" : ""}`;
}

type SearchResponse = {
  messages?: AgentMessageRecord[];
  hasMore?: boolean;
  nextCursor?: string;
  incomplete?: boolean;
  /** With `incomplete`: how many messages the server read before it stopped. */
  searchedMessages?: number;
  /** With `incomplete`: the oldest time (ISO) the server reached before it stopped. */
  searchedThrough?: string;
};

type SearchFormatOptions = {
  target?: string;
  sender?: string;
  sort?: "relevance" | "recent";
  before?: string;
  after?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
};

const SEARCH_CONTEXT_TIP =
  'If a result may be relevant but its preview is not enough, read its surrounding context with coforge message read --target "<target>" --around <shortId>.';

const SEARCH_NARROW_TIP = "Or narrow the search: add --target '#<channel>' or --sender <handle>.";

/** The command that repeats this search with `paging` in place of its own position. */
function searchPageCommand(
  query: string,
  options: SearchFormatOptions,
  paging: { before?: string; offset?: number; cursor?: string },
): string {
  const args = ["coforge message search"];
  if (query) args.push(`--query ${JSON.stringify(query)}`);
  if (options.target !== undefined) args.push(`--target ${JSON.stringify(options.target)}`);
  if (options.sender !== undefined) args.push(`--sender ${JSON.stringify(options.sender)}`);
  if (options.sort !== undefined) args.push(`--sort ${options.sort}`);
  const before = paging.before ?? options.before;
  if (before !== undefined) args.push(`--before ${JSON.stringify(before)}`);
  if (options.after !== undefined) args.push(`--after ${JSON.stringify(options.after)}`);
  if (options.limit !== undefined) args.push(`--limit ${options.limit}`);
  if (paging.offset !== undefined) args.push(`--offset ${paging.offset}`);
  if (paging.cursor !== undefined) args.push(`--cursor ${JSON.stringify(paging.cursor)}`);
  return args.join(" ");
}

/** The paging hint for a page that is not the last: a cursor continues a `recent` search with a
 * query exactly; without one a `recent` search steps back to the last shown time and a relevance
 * search skips what it showed. */
function searchPaging(
  response: SearchResponse,
  options: SearchFormatOptions,
  query: string,
  messages: readonly AgentMessageRecord[],
): { command: string; hint: string } {
  if (response.nextCursor !== undefined && query) {
    return {
      command: searchPageCommand(
        query,
        { ...options, sort: "recent" },
        { cursor: response.nextCursor },
      ),
      hint: "; the Next page command below continues exactly after this page",
    };
  }
  if (options.sort === "recent") {
    const before = messages.at(-1)!.createdAt;
    return {
      command: searchPageCommand(query, options, { before }),
      hint: `, page with --before ${before} (pages OLDER only; NOT a complete traversal: stored times are microsecond but this key is millisecond, so rows inside the boundary millisecond can be skipped, and a full page sharing one timestamp can repeat indefinitely; copy the key verbatim)`,
    };
  }
  const offset = (options.offset ?? 0) + messages.length;
  return {
    command: searchPageCommand(query, options, { offset }),
    hint: `, page with --offset ${offset}`,
  };
}

/** The agent-facing note on whether this page is everything, as the title line carries it. */
function searchTruncation(response: SearchResponse, paging: { hint: string } | undefined): string {
  if (response.incomplete === true) {
    const reached =
      response.searchedMessages !== undefined && response.searchedThrough !== undefined
        ? `stopped after reading ${response.searchedMessages} messages, back to ${formatLocalTimeWithOffset(response.searchedThrough)}; `
        : "";
    return `incomplete=true · ${reached}older messages were not searched, so these are NOT all the matches`;
  }
  if (response.hasMore === true) return `truncated=true · more results exist${paging?.hint ?? ""}`;
  if (response.hasMore === false) return "truncated=false";
  return "truncated=unknown · server did not report hasMore";
}

export function formatSearchResults(
  query: string,
  response: SearchResponse,
  options: SearchFormatOptions = {},
): string {
  const messages = response.messages ?? [];
  const incomplete = response.incomplete === true;
  const more = incomplete || response.hasMore === true;
  // A page with nothing to step from cannot say where the next one starts.
  const paging =
    more && messages.length > 0 ? searchPaging(response, options, query, messages) : undefined;
  const truncation = searchTruncation(response, paging);
  // Where to go on: the cursor's Next lines, which an incomplete search words as a wider look.
  const next = !more
    ? []
    : response.nextCursor !== undefined && query
      ? incomplete
        ? [
            `Next (search older messages): ${paging!.command}`,
            ...(options.target === undefined && options.sender === undefined
              ? [SEARCH_NARROW_TIP]
              : []),
          ]
        : [`Next page: ${paging!.command}`]
      : paging
        ? [`Next page: ${paging.command}`]
        : [];

  if (messages.length === 0) {
    return incomplete
      ? [
          "Search incomplete: no matches in the messages searched so far. Older messages were not searched, so this does NOT mean no message matches. (incomplete=true)",
          ...next,
        ].join("\n")
      : `No search results. (${truncation})`;
  }

  const count = messages.length;
  const noun = count === 1 ? "result" : "results";
  const header = query
    ? `Search results for: "${query}" (${count} ${noun} · ${truncation})`
    : `Filtered message results (${count} ${noun} · ${truncation})`;

  const blocks = messages.map((message) =>
    [
      `<result ref="msg:${message.id}">`,
      `Source: ${message.target}`,
      `Sender: ${neutralizeReferenceLiterals(messageSender(message))}`,
      `Time: ${formatLocalTimeWithOffset(message.createdAt)}`,
      ...(message.task ? [taskSuffix(message).trim()] : []),
      "",
      "<preview>",
      fenceMessageBody(renderSearchPreview(message.body, query)),
      "</preview>",
      "</result>",
    ].join("\n"),
  );

  return [header, "", blocks.join("\n\n"), "", SEARCH_CONTEXT_TIP, ...next].join("\n");
}
