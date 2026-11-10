import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";
import { SearchLg, XClose } from "@untitledui/icons";
import { Input as AriaInput } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { channelLabel } from "#src/features/conversations/channel-visibility";
import { isImeComposing } from "#src/lib/ime";
import { m } from "#src/paraglide/messages";
import type { SearchIntent } from "./search-dialog-context";
import { SearchFilterChips, SearchFilterMenu, useSearchChannel } from "./search-filter-bar";
import { clearedFilters, hasActiveFilter, type SearchFilters } from "./search-filters";
import { SearchHome } from "./search-home";
import { SearchKeyHints } from "./search-key-hints";
import { searchEntityKey } from "./search-memory";
import { SearchResults } from "./search-results";
import { SEARCH_FOCUS_EVENT } from "./search-shortcut";
import { SEARCH_QUERY_MAX_LENGTH } from "./search.schemas";
import { useSearchMemory } from "./use-search-memory";

/** Pause in typing before the query is searched. */
const COMMIT_DELAY_MS = 200;

/** What the arrow keys walk through: the results and the remembered places, in reading order. */
const OPTION = "[data-search-option]";
/** Set on the first option: Enter in the box opens it, so it shows as chosen while the box has focus. */
const FIRST_OPTION = "data-search-first";

function selectBox(box: HTMLInputElement | null) {
  box?.focus();
  box?.select();
}

/**
 * Workspace search, over the current page: the viewer's history and frequent places until something
 * is typed, then channels, Agents, Computers and messages. Opening a result closes the dialog. Up
 * and Down move the real focus along the results, so a screen reader follows and Enter opens the
 * link; typing returns to the box.
 */
export function SearchDialog({
  workspaceId,
  viewerId,
  timeZone,
  intent,
  onClose,
}: {
  workspaceId: string;
  viewerId: string;
  timeZone: string | null;
  intent: SearchIntent;
  onClose: () => void;
}) {
  const memory = useSearchMemory(workspaceId, viewerId);
  const [text, setText] = useState(intent.query ?? "");
  const [query, setQuery] = useState(text.trim());
  const [filters, setFilters] = useState<SearchFilters>(intent.filters ?? {});
  const [deferred, setDeferred] = useState(Boolean(intent.deferred));
  const scopedChannel = useSearchChannel(workspaceId, filters.channelId);
  const [composing, setComposing] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const next = text.trim();
    if (composing || next === query) return;
    const timer = setTimeout(() => setQuery(next), COMMIT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, composing, query]);

  const onFocusRequest = useEffectEvent(() => selectBox(box.current));
  useEffect(() => {
    selectBox(box.current);
    document.addEventListener(SEARCH_FOCUS_EVENT, onFocusRequest);
    return () => document.removeEventListener(SEARCH_FOCUS_EVENT, onFocusRequest);
  }, []);

  // The options arrive with their queries, so the first one is found whenever the list changes.
  useEffect(() => {
    const root = list.current;
    if (!root) return;
    const mark = () => {
      root.querySelector(`[${FIRST_OPTION}]`)?.removeAttribute(FIRST_OPTION);
      root.querySelector(OPTION)?.setAttribute(FIRST_OPTION, "");
    };
    mark();
    const observer = new MutationObserver(mark);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event)) return;
    const typing = event.key.length === 1 && !event.metaKey && !event.ctrlKey;
    if (!typing && !["Enter", "ArrowDown", "ArrowUp"].includes(event.key)) return;
    const inBox = event.target === box.current;
    const options = [...(list.current?.querySelectorAll<HTMLElement>(OPTION) ?? [])];
    const index = options.indexOf(event.target as HTMLElement);
    if (!inBox && index < 0) return;
    if (event.key === "Enter" && inBox) {
      event.preventDefault();
      // Words not yet searched would open the previous results' first row: search them now.
      if (text.trim() !== query) setQuery(text.trim());
      else options[0]?.click();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      // From the box the first option already shows as chosen, so Down goes to the next.
      (options[index + (inBox ? 2 : 1)] ?? options.at(inBox ? 0 : -1))?.focus();
    } else if (event.key === "ArrowUp" && !inBox) {
      event.preventDefault();
      if (index === 0) box.current?.focus();
      else options[index - 1]?.focus();
    } else if (!inBox && typing && event.key !== " ") {
      // Space presses the focused option; any other character is typed into the box.
      box.current?.focus();
    }
  };

  const changeFilters = (next: SearchFilters) => {
    setDeferred(false);
    setFilters(next);
  };
  const searching = query || (hasActiveFilter(filters) && !deferred);
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => !open && onClose()}
      // With the top bar (lg), the panel opens where its field is, over it, rather than mid-screen
      // (Frank, 11-10, design A); without it, high on the screen. Search opens hundreds of times a
      // day, from the keyboard as often as not, so it neither fades nor zooms, and the page behind
      // only dims: flat, no frosted glass (docs/design/ui-principles.md).
      className="bg-overlay/30 backdrop-blur-none max-sm:px-0 max-sm:[--modal-pb:0px] max-sm:[--modal-pt:0px] sm:items-start sm:[--modal-pt:12vh] lg:animate-none lg:[--modal-pt:0.125rem]"
    >
      {/* In dark, one surface up from the page with a hairline edge, as the New task window. */}
      <Modal className="flex w-full flex-col max-sm:h-full max-sm:rounded-none sm:max-w-[40rem] lg:animate-none dark:bg-secondary dark:ring-1 dark:ring-secondary_alt">
        <Dialog
          aria-label={m.search_title()}
          className="group/search min-h-0 flex-1 overflow-hidden"
        >
          <div
            ref={panel}
            onKeyDown={onKeyDown}
            className="flex max-h-[inherit] h-full min-h-0 flex-col"
          >
            <div
              // With the top bar, the first row is 44px and the panel opens 2px from the window's
              // top, so the row's middle is the field's (6px down, 36px tall): the text stays on
              // the line it was typed toward.
              className="flex flex-col gap-3 border-b border-secondary p-4 lg:gap-0 lg:py-0"
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
            >
              <div className="flex items-center gap-3 lg:h-11">
                <SearchLg aria-hidden="true" className="size-5 shrink-0 text-fg-brand-primary" />
                <AriaInput
                  type="search"
                  aria-label={m.search_title()}
                  placeholder={m.search_placeholder()}
                  maxLength={SEARCH_QUERY_MAX_LENGTH}
                  ref={box}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  className="w-full min-w-0 bg-transparent text-lg text-primary caret-fg-brand-primary outline-hidden placeholder:text-placeholder [&::-webkit-search-cancel-button]:appearance-none"
                />
                <SearchFilterMenu
                  workspaceId={workspaceId}
                  query={query}
                  filters={filters}
                  onChange={changeFilters}
                  besideRef={panel}
                />
                {/* A phone has no Esc and no backdrop to tap: the dialog fills the screen. */}
                <ButtonUtility
                  icon={XClose}
                  size="sm"
                  color="tertiary"
                  className="sm:hidden"
                  tooltip={m.controls_close()}
                  aria-label={m.controls_close()}
                  onClick={onClose}
                />
              </div>
              <SearchFilterChips
                workspaceId={workspaceId}
                filters={filters}
                onChange={changeFilters}
              />
            </div>
            <div ref={list} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              {searching ? (
                <SearchResults
                  workspaceId={workspaceId}
                  timeZone={timeZone}
                  query={query}
                  filters={filters}
                  onOpen={(entity) => {
                    memory.recordOpen(query, entity);
                    onClose();
                  }}
                  onClear={() => {
                    if (query) {
                      setText("");
                      setQuery("");
                    } else setFilters(clearedFilters(filters));
                    box.current?.focus();
                  }}
                />
              ) : (
                <SearchHome
                  workspaceId={workspaceId}
                  channel={scopedChannel ? channelLabel(scopedChannel) : undefined}
                  loaded={memory.loaded}
                  history={memory.history}
                  usage={memory.usage}
                  onSearch={(next) => {
                    setText(next);
                    setQuery(next);
                    box.current?.focus();
                  }}
                  onRemoveSearch={(entry) => {
                    memory.removeSearch(entry);
                    box.current?.focus();
                  }}
                  onClearHistory={() => {
                    memory.clearHistory();
                    box.current?.focus();
                  }}
                  onOpen={(entity) => {
                    memory.recordOpen("", searchEntityKey(entity));
                    onClose();
                  }}
                />
              )}
            </div>
            <SearchKeyHints />
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
