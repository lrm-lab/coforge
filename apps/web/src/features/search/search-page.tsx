import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { SearchLg } from "@untitledui/icons";

import { Input } from "#src/components/base/input/input";
import { PageHeader } from "#src/components/layout/page-header";
import { LIST_BESIDE_CLASSES } from "#src/features/conversations/conversation-list-button";
import { ConversationListResizeHandle } from "#src/features/conversations/conversation-list-resize-handle";
import { LIST_COLUMN } from "#src/features/conversations/conversation-list-width";
import type { HostedConversationTarget } from "#src/features/conversations/conversation-page-search";
import { useWorkspaceSlug } from "#src/features/workspaces/workspace-route";
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
import { SEARCH_LIST_BESIDE_FROM, SearchPreview } from "./search-preview";
import { SearchPreviewContext } from "./search-preview-context";
import { SearchHome } from "./search-home";
import { searchEntityKey } from "./search-memory";
import { SearchResults } from "./search-results";
import {
  lastPageBeforeSearch,
  SEARCH_FOCUS_EVENT,
  useSearchShortcutLabel,
} from "./search-shortcut";
import { useSearchMemory } from "./use-search-memory";
import { SearchFilterBar } from "./search-filter-bar";
import { clearedFilters, hasActiveFilter, type SearchFilters } from "./search-filters";
import { SEARCH_QUERY_MAX_LENGTH } from "./search.schemas";

/** Pause in typing before the query is committed to the URL and searched. */
const COMMIT_DELAY_MS = 200;

/** Focuses the search box with its text selected, ready to be typed over. */
function selectBox(box: HTMLInputElement | null) {
  box?.focus();
  box?.select();
}

/**
 * The Workspace search page. The query and filters live in the URL, so a search can be shared,
 * reloaded, and returned to with Back; typing commits the query after a short pause, and never
 * while an input method is still composing. Filters search on their own, without a query.
 * A click previews a result's conversation (kept in the URL), where it can be replied to: beside
 * the list from `md` up, in its place below, with a back arrow to it; a double click opens it. Esc
 * outside the conversation closes the preview, then leaves.
 */
export function SearchPage({
  workspaceId,
  viewerId,
  deferred,
  timeZone,
  query,
  filters,
  onQueryChange,
  onFiltersChange,
  preview,
  onPreviewChange,
  onPreviewClose,
}: {
  workspaceId: string;
  viewerId: string;
  /** Filters alone do not search yet ("Search this channel" waits for a query). */
  deferred: boolean;
  timeZone: string | null;
  query: string;
  filters: SearchFilters;
  onQueryChange: (query: string) => void;
  onFiltersChange: (filters: SearchFilters) => void;
  preview: HostedConversationTarget | undefined;
  onPreviewChange: (preview: HostedConversationTarget) => void;
  onPreviewClose: () => void;
}) {
  const memory = useSearchMemory(workspaceId, viewerId);
  const router = useRouter();
  const workspaceSlug = useWorkspaceSlug();
  const previewContext = useMemo(
    () => ({ previewed: preview, preview: onPreviewChange }),
    [preview, onPreviewChange],
  );
  const shortcut = useSearchShortcutLabel();
  // Below `SEARCH_LIST_BESIDE_FROM` a preview takes the results' place, hiding the box with them.
  const previewBeside = useBreakpoint(SEARCH_LIST_BESIDE_FROM);
  const boxHidden = Boolean(preview) && !previewBeside;
  const [text, setText] = useState(query);
  // State, not a ref: ending a composition must re-run the commit effect even when the last
  // input event (which browsers fire before `compositionend`) already set the final text.
  const [composing, setComposing] = useState(false);
  // The query this input last committed, so its own URL update never overwrites what has been
  // typed since; only a change from elsewhere (a link, Back) replaces the text.
  const lastCommitted = useRef(query);
  const input = useRef<HTMLInputElement>(null);
  const previewSection = useRef<HTMLElement>(null);
  const committed = query.trim();

  useEffect(() => {
    if (query === lastCommitted.current) return;
    lastCommitted.current = query;
    setText(query);
  }, [query]);

  useEffect(() => {
    // Surrounding spaces never change the search, so they are not committed (and a space
    // typed ahead of a word is not wiped by the URL coming back without it).
    const next = text.trim();
    // A preview that hides the box holds its commit until the results show again, so a commit
    // landing after a tap never rewrites the preview's entry.
    if (composing || boxHidden || next === lastCommitted.current) return;
    const timer = setTimeout(() => {
      lastCommitted.current = next;
      onQueryChange(next);
    }, COMMIT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, composing, boxHidden, onQueryChange]);

  // The box opens focused with its text selected, ready to be typed over; Cmd/Ctrl+K on this
  // page does the same again. A preview that has taken the results' place hides the box with
  // them, so the shortcut closes it first and the box takes focus once the results show.
  const focusOnResults = useRef(false);
  const onSearchFocus = useEffectEvent(() => {
    if (boxHidden) {
      focusOnResults.current = true;
      onPreviewClose();
    } else selectBox(input.current);
  });
  useEffect(() => {
    selectBox(input.current);
    document.addEventListener(SEARCH_FOCUS_EVENT, onSearchFocus);
    return () => document.removeEventListener(SEARCH_FOCUS_EVENT, onSearchFocus);
  }, []);
  // Any change of preview settles the shortcut's wait: only the results showing take the focus.
  useEffect(() => {
    const waiting = focusOnResults.current;
    focusOnResults.current = false;
    if (waiting && !preview) selectBox(input.current);
  }, [preview]);

  // Esc closes the preview, then leaves search for wherever it was opened from. A menu or dialog
  // takes its own Esc, so does the previewed conversation (its composer, its thread), and a
  // filled box clears itself first.
  const onEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[role="menu"], [role="listbox"], [role="dialog"]')) return;
    if (target && previewSection.current?.contains(target)) return;
    if (preview) {
      // Only the preview closes: a search box's own Esc would also clear the query.
      event.preventDefault();
      onPreviewClose();
      return;
    }
    if (target instanceof HTMLInputElement && target.value) return;
    const origin = lastPageBeforeSearch();
    if (origin) void router.navigate({ href: origin, replace: true });
    else
      void router.navigate({ to: "/w/$workspaceSlug", params: { workspaceSlug }, replace: true });
  });
  useEffect(() => {
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, []);

  return (
    <SearchPreviewContext.Provider value={previewContext}>
      <main className="flex h-full min-w-0 bg-primary">
        <div
          className={
            // Below `SEARCH_LIST_BESIDE_FROM` the preview takes the list's place; the list stays mounted.
            preview
              ? cx(
                  "relative flex w-list-column shrink-0 flex-col",
                  LIST_BESIDE_CLASSES[SEARCH_LIST_BESIDE_FROM].list,
                )
              : "flex min-w-0 flex-1 flex-col"
          }
        >
          <PageHeader heading={m.search_title()} />
          <div
            className="border-b border-secondary px-page py-3"
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
          >
            <Input
              type="search"
              size="md"
              icon={SearchLg}
              aria-label={m.search_title()}
              placeholder={m.search_placeholder()}
              maxLength={SEARCH_QUERY_MAX_LENGTH}
              ref={input}
              shortcut={shortcut}
              autoFocus
              value={text}
              onChange={setText}
              className="w-full"
            />
            <div className="mt-3">
              <SearchFilterBar
                workspaceId={workspaceId}
                query={committed}
                filters={filters}
                onChange={onFiltersChange}
              />
            </div>
          </div>
          {committed || (hasActiveFilter(filters) && !deferred) ? (
            <SearchResults
              workspaceId={workspaceId}
              timeZone={timeZone}
              query={committed}
              filters={filters}
              onOpen={(entity) => memory.recordOpen(committed, entity)}
              onClear={() => {
                if (committed) {
                  lastCommitted.current = "";
                  setText("");
                  onQueryChange("");
                } else {
                  onFiltersChange(clearedFilters(filters));
                }
                // The button goes away with the results; keep the keyboard in the search box.
                input.current?.focus();
              }}
            />
          ) : (
            <SearchHome
              workspaceId={workspaceId}
              loaded={memory.loaded}
              history={memory.history}
              usage={memory.usage}
              onSearch={(next) => {
                lastCommitted.current = next;
                setText(next);
                onQueryChange(next);
                input.current?.focus();
              }}
              onRemoveSearch={(entry) => {
                memory.removeSearch(entry);
                // The removed chip took focus with it; keep the keyboard in the search box.
                input.current?.focus();
              }}
              onClearHistory={() => {
                memory.clearHistory();
                input.current?.focus();
              }}
              onOpen={(entity) => memory.recordOpen("", searchEntityKey(entity))}
            />
          )}
          {preview && (
            <ConversationListResizeHandle
              column={LIST_COLUMN}
              visibleFrom={SEARCH_LIST_BESIDE_FROM}
            />
          )}
        </div>
        {preview && (
          <SearchPreview
            key={`${preview.kind}:${preview.id}`}
            ref={previewSection}
            target={preview}
            onClose={onPreviewClose}
          />
        )}
      </main>
    </SearchPreviewContext.Provider>
  );
}
