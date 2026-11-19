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
import { useBreakpoint } from "#src/hooks/use-breakpoint";
import { usePrefersReducedMotion } from "#src/hooks/use-prefers-reduced-motion";
import {
  CONTINUOUS_EASING,
  animateFlipFromRect,
  animateFlipToRect,
  cancelFlipAnimation,
  isRectInViewport,
} from "#src/lib/shared-element-rect";
import { channelLabel } from "#src/features/conversations/channel-visibility";
import { isImeComposing } from "#src/lib/ime";
import { m } from "#src/paraglide/messages";
import { cx } from "#src/utils/cx";
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
  const reduced = usePrefersReducedMotion();
  const desktop = useBreakpoint("sm");
  const [text, setText] = useState(intent.query ?? "");
  const [query, setQuery] = useState(text.trim());
  const [filters, setFilters] = useState<SearchFilters>(intent.filters ?? {});
  const [deferred, setDeferred] = useState(Boolean(intent.deferred));
  const scopedChannel = useSearchChannel(workspaceId, filters.channelId);
  const [composing, setComposing] = useState(false);
  const hasOrigin = !reduced && Boolean(intent.originRect && isRectInViewport(intent.originRect));
  const [bodyVisible, setBodyVisible] = useState(() => !hasOrigin);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const dialogRef = useRef<HTMLElement>(null);
  const box = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const modalEl = dialogRef.current?.parentElement;
    if (!modalEl || reduced) {
      setBodyVisible(true);
      return;
    }
    const origin = intent.originRect;
    if (origin && isRectInViewport(origin)) {
      const duration = desktop ? 260 : 380;
      animateFlipFromRect(modalEl, origin, {
        duration,
        mode: "box",
        includeRadius: true,
      });
      const timer = window.setTimeout(() => setBodyVisible(true), Math.round(duration * 0.42));
      return () => {
        window.clearTimeout(timer);
        cancelFlipAnimation(modalEl);
      };
    }
    setBodyVisible(true);
    if (typeof modalEl.animate !== "function") return;
    const duration = intent.source === "keyboard" ? 180 : desktop ? 220 : 320;
    const anim = modalEl.animate(
      [
        { opacity: 0, transform: "translate3d(0, -10px, 0) scale(0.985)" },
        { opacity: 1, transform: "translate3d(0, 0, 0) scale(1)" },
      ],
      { duration, easing: CONTINUOUS_EASING },
    );
    return () => anim.cancel();
  }, [desktop, intent.originRect, intent.source, reduced]);

  const requestDismiss = useCallback(() => {
    if (closingRef.current) {
      onClose();
      return;
    }
    const modalEl = dialogRef.current?.parentElement;
    const origin = intent.originRect;
    if (reduced || !modalEl || !origin || !isRectInViewport(origin)) {
      onClose();
      return;
    }
    closingRef.current = true;
    setClosing(true);
    const anim = animateFlipToRect(modalEl, origin, {
      duration: desktop ? 200 : 280,
      mode: "box",
      includeRadius: true,
    });
    if (!anim) {
      onClose();
      return;
    }
    const done = () => onClose();
    anim.addEventListener("finish", done, { once: true });
    anim.addEventListener("cancel", done, { once: true });
  }, [desktop, intent.originRect, onClose, reduced]);

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
  const [inputFocused, setInputFocused] = useState(false);
  const searching = query || (hasActiveFilter(filters) && !deferred);
  const bodyHidden = closing || !bodyVisible;
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => !open && requestDismiss()}
      className={cx(
        "bg-overlay/30 backdrop-blur-none transition-opacity duration-150 max-sm:px-0 max-sm:[--modal-pb:0px] max-sm:[--modal-pt:0px] sm:items-start sm:[--modal-pt:12vh]",
        closing && "opacity-0",
      )}
    >
      <Modal
        className={cx(
          "flex w-full flex-col overflow-hidden max-sm:h-full max-sm:rounded-none sm:max-w-[40rem] dark:bg-secondary",
          !reduced && "animate-none",
        )}
      >
        <Dialog
          ref={dialogRef}
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
                  className={cx(
                    "transition-[transform,opacity] duration-200 ease-(--ease-continuous) sm:hidden",
                    bodyHidden && "translate-x-2 opacity-0",
                  )}
                  tooltip={m.controls_close()}
                  aria-label={m.controls_close()}
                  onClick={requestDismiss}
                />
              </div>
              <div
                className={cx(
                  "transition-opacity duration-150",
                  bodyHidden && "pointer-events-none opacity-0",
                )}
              >
                <SearchFilterBar
                  workspaceId={workspaceId}
                  filters={filters}
                  onChange={changeFilters}
                />
              </div>
            </div>
            <div
              ref={list}
              className={cx(
                "flex min-h-0 flex-1 flex-col overflow-y-auto transition-opacity duration-150",
                bodyHidden && "pointer-events-none opacity-0",
              )}
            >
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
            <div
              className={cx(
                "transition-opacity duration-150",
                bodyHidden && "pointer-events-none opacity-0",
              )}
            >
              <SearchKeyHints />
            </div>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
