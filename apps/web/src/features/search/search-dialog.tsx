import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { SearchLg, XClose } from "@untitledui/icons";
import { Input as AriaInput } from "react-aria-components";

import { ButtonUtility } from "#src/components/base/buttons/button-utility";
import { Dialog, Modal, ModalOverlay } from "#src/components/ui/modal";
import { channelLabel } from "#src/features/conversations/channel-visibility";
import { isImeComposing } from "#src/lib/ime";
import { m } from "#src/paraglide/messages";
import type { SearchIntent } from "./search-dialog-context";
import { SearchFilterBar, useSearchChannel } from "./search-filter-bar";
import { clearedFilters, hasActiveFilter, type SearchFilters } from "./search-filters";
import { SearchHome } from "./search-home";
import { SearchKeyHints } from "./search-key-hints";
import { searchEntityKey } from "./search-memory";
import { SearchResults } from "./search-results";
import { SEARCH_FOCUS_EVENT } from "./search-shortcut";
import { SEARCH_QUERY_MAX_LENGTH } from "./search.schemas";
import { useSearchMemory } from "./use-search-memory";

const COMMIT_DELAY_MS = 200;

const OPTION = "[data-search-option]";
const FIRST_OPTION = "data-search-first";

function selectBox(box: HTMLInputElement | null) {
  box?.focus();
  box?.select();
}

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
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const next = text.trim();
    if (composing || next === query) return;
    const timer = setTimeout(() => setQuery(next), COMMIT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, composing, query]);

  const onFocusRequest = useEffectEvent(() => selectBox(box.current));
  useLayoutEffect(() => {
    selectBox(box.current);
  }, []);
  useEffect(() => {
    document.addEventListener(SEARCH_FOCUS_EVENT, onFocusRequest);
    return () => document.removeEventListener(SEARCH_FOCUS_EVENT, onFocusRequest);
  }, []);

  useLayoutEffect(() => {
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
      if (text.trim() !== query) setQuery(text.trim());
      else options[0]?.click();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      (options[index + (inBox ? 2 : 1)] ?? options.at(inBox ? 0 : -1))?.focus();
    } else if (event.key === "ArrowUp" && !inBox) {
      event.preventDefault();
      if (index === 0) box.current?.focus();
      else options[index - 1]?.focus();
    } else if (!inBox && typing && event.key !== " ") {
      box.current?.focus();
    }
  };

  const changeFilters = useCallback((next: SearchFilters) => {
    setDeferred(false);
    setFilters(next);
  }, []);
  const [inputFocused, setInputFocused] = useState(true);
  const searching = query || (hasActiveFilter(filters) && !deferred);
  return (
    <ModalOverlay
      isOpen
      isDismissable
      instant
      onOpenChange={(open) => !open && onClose()}
      className="bg-overlay/30 backdrop-blur-none max-sm:px-0 max-sm:[--modal-pb:0px] max-sm:[--modal-pt:0px] sm:items-start sm:[--modal-pt:12vh]"
    >
      <Modal className="flex w-full flex-col overflow-hidden max-sm:h-full max-sm:rounded-none sm:max-w-[40rem] dark:bg-secondary">
        <Dialog
          aria-label={m.search_title()}
          data-input-focused={inputFocused ? "" : undefined}
          className="group/search min-h-0 flex-1 overflow-hidden"
        >
          <div onKeyDown={onKeyDown} className="flex h-full max-h-[inherit] min-h-0 flex-col">
            <div
              className="flex flex-col gap-3 border-b border-secondary px-4 pt-3.5 pb-3"
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
            >
              <div className="flex items-center gap-3">
                <SearchLg aria-hidden="true" className="size-5 shrink-0 text-fg-brand-primary" />
                <AriaInput
                  autoFocus
                  type="search"
                  aria-label={m.search_title()}
                  placeholder={m.search_placeholder()}
                  maxLength={SEARCH_QUERY_MAX_LENGTH}
                  ref={box}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onFocus={() => setInputFocused(true)}
                  onBlur={() => setInputFocused(false)}
                  className="w-full min-w-0 bg-transparent text-lg text-primary caret-fg-brand-primary outline-hidden placeholder:text-placeholder [&::-webkit-search-cancel-button]:appearance-none"
                />
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
              <SearchFilterBar
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
